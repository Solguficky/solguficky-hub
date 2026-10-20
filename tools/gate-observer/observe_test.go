package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	jevKey   = "jev-key-marker-6f1c"
	clefKey  = "clef-key-marker-9a2d"
	decision = "Тест на граничную цену лота положен рядом с юзкейсом ставки. Источник: постановка задачи."
)

// stub records what reached it and answers with a canned reply.
type stub struct {
	status int
	reply  string
	delay  time.Duration

	mu     sync.Mutex
	auth   string
	bodies [][]byte
}

func (s *stub) serve(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.auth = r.Header.Get("Authorization")
		s.bodies = append(s.bodies, body)
		s.mu.Unlock()
		if s.delay > 0 {
			select {
			case <-time.After(s.delay):
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(s.status)
		_, _ = io.WriteString(w, s.reply)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

const (
	jevReply  = `{"model":"jev-1.13.0","answers":{"gate":{"type":"noul","noul":0.07}},"usage":{"input_tokens":120,"output_tokens":0}}`
	clefReply = `{"result":{"model":"clef","answers":{"gate":{"type":"noul","noul":0.91}},"usage":{"input_tokens":120,"output_tokens":0}},"success":true,"errors":[],"messages":[]}`
)

type env map[string]string

func (e env) get(k string) string { return e[k] }

func observe(t *testing.T, e env, args ...string) (string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(append([]string{"-timeout", "300ms"}, args...), strings.NewReader(decision), &out, &errOut, e.get)
	return out.String(), errOut.String(), code
}

func bothKeys(jevURL, clefURL string) env {
	return env{
		"TYPESAFE_API_KEY": jevKey, "JEV_URL": jevURL,
		"CF_API_TOKEN": clefKey, "CF_ACCOUNT_ID": "acc", "CLEF_URL": clefURL,
	}
}

func TestBothProvidersAnswer(t *testing.T) {
	t.Parallel()
	j := &stub{status: 200, reply: jevReply}
	c := &stub{status: 200, reply: clefReply}
	out, _, code := observe(t, bothKeys(j.serve(t), c.serve(t)), "-point", "decided")

	if code != 0 {
		t.Fatalf("code %d, want 0", code)
	}
	for _, want := range []string{"Jev 0.07 (jev-1.13.0)", "Clef 0.91 (clef)", "вопрос decided@" + questionsVersion()} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
	if j.auth != "Bearer "+jevKey || c.auth != "Bearer "+clefKey {
		t.Errorf("each provider gets its own bearer key: jev %q, clef %q", j.auth, c.auth)
	}
}

func TestNoKeysIsUnavailableNotFailure(t *testing.T) {
	t.Parallel()
	out, _, code := observe(t, env{}, "-point", "ask")

	if code != 0 {
		t.Fatalf("code %d, want 0: a delivery never stops on an observer", code)
	}
	for _, want := range []string{"Jev недоступен (нет ключа TYPESAFE_API_KEY)", "Clef недоступен (нет ключа CF_API_TOKEN)"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
}

func TestOneProviderFailsTheOtherAnswers(t *testing.T) {
	t.Parallel()
	j := &stub{status: 200, reply: jevReply}
	e := bothKeys(j.serve(t), "")
	delete(e, "CF_ACCOUNT_ID")
	out, _, _ := observe(t, e, "-point", "plan")

	if !strings.Contains(out, "Jev 0.07 (jev-1.13.0)") || !strings.Contains(out, "Clef недоступен (нет ключа CF_ACCOUNT_ID)") {
		t.Errorf("columns fail independently, got %q", out)
	}
}

func TestBadRepliesAreUnavailable(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		stub *stub
		want string
	}{
		{"unauthorized", &stub{status: 401, reply: `{"error":"bad key"}`}, "HTTP 401"},
		{"server error", &stub{status: 500, reply: `oops`}, "HTTP 500"},
		{"not json", &stub{status: 200, reply: `<html>`}, "ответ не JSON"},
		{"no answer", &stub{status: 200, reply: `{"model":"jev-1.13.0","answers":{}}`}, "в ответе нет noul"},
		{"wrong type", &stub{status: 200, reply: `{"answers":{"gate":{"type":"score","score":3}}}`}, "в ответе нет noul"},
		{"out of range", &stub{status: 200, reply: `{"answers":{"gate":{"type":"noul","noul":1.4}}}`}, "вероятность вне 0..1"},
		{"timeout", &stub{status: 200, reply: jevReply, delay: 2 * time.Second}, "таймаут"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := bothKeys(tc.stub.serve(t), "")
			delete(e, "CF_API_TOKEN")
			out, _, code := observe(t, e, "-point", "decided")
			if code != 0 || !strings.Contains(out, "Jev недоступен ("+tc.want+")") {
				t.Errorf("code %d, output %q, want Jev недоступен (%s)", code, out, tc.want)
			}
		})
	}
}

func TestClosedPortIsNetwork(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	e := bothKeys(url, "")
	delete(e, "CF_API_TOKEN")
	out, _, _ := observe(t, e, "-point", "ask")
	if !strings.Contains(out, "Jev недоступен (сеть)") {
		t.Errorf("got %q", out)
	}
}

func TestMissingModelVersionIsNamed(t *testing.T) {
	t.Parallel()
	j := &stub{status: 200, reply: `{"answers":{"gate":{"type":"noul","noul":0.5}}}`}
	e := bothKeys(j.serve(t), "")
	delete(e, "CF_API_TOKEN")
	out, _, _ := observe(t, e, "-point", "ask")
	if !strings.Contains(out, "Jev 0.50 (версия не отдана)") {
		t.Errorf("got %q", out)
	}
}

// Only the decision, the model and the question leave the machine, and the
// key travels in the header alone — never in the body or in any output.
func TestKeysAndContextDoNotLeak(t *testing.T) {
	t.Parallel()
	j := &stub{status: 500, reply: `{"echo":"` + jevKey + `"}`}
	c := &stub{status: 200, reply: clefReply}
	e := bothKeys(j.serve(t), c.serve(t))
	out, errOut, _ := observe(t, e, "-point", "decided")
	dry, _, _ := observe(t, e, "-point", "decided", "-dry-run")

	for _, text := range []string{out, errOut, dry} {
		if strings.Contains(text, jevKey) || strings.Contains(text, clefKey) {
			t.Errorf("a key leaked into output: %q", text)
		}
	}
	for _, s := range []*stub{j, c} {
		for _, body := range s.bodies {
			assertOnlyDecisionSent(t, body)
		}
	}
}

func assertOnlyDecisionSent(t *testing.T, body []byte) {
	t.Helper()
	if bytes.Contains(body, []byte(jevKey)) || bytes.Contains(body, []byte(clefKey)) {
		t.Errorf("a key leaked into the request body: %s", body)
	}
	var sent map[string]json.RawMessage
	if err := json.Unmarshal(body, &sent); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	for k := range sent {
		if k != "model" && k != "state" && k != "questions" {
			t.Errorf("unexpected field %q leaves the machine", k)
		}
	}
	var state string
	_ = json.Unmarshal(sent["state"], &state)
	if state != decision {
		t.Errorf("state %q, want the stdin decision only", state)
	}
}

func TestDryRunSendsNothing(t *testing.T) {
	t.Parallel()
	j := &stub{status: 200, reply: jevReply}
	c := &stub{status: 200, reply: clefReply}
	out, _, code := observe(t, bothKeys(j.serve(t), c.serve(t)), "-point", "plan", "-dry-run")

	if code != 0 || len(j.bodies)+len(c.bodies) != 0 {
		t.Fatalf("code %d, requests jev %d clef %d: dry run must send nothing", code, len(j.bodies), len(c.bodies))
	}
	if !strings.Contains(out, `"type": "noul"`) || !strings.Contains(out, `"model": "clef"`) {
		t.Errorf("dry run prints the bodies, got %q", out)
	}
}

func TestWrongCallsExitTwo(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		args  []string
		stdin string
	}{
		"no point":      {nil, decision},
		"unknown point": {[]string{"-point", "phase"}, decision},
		"empty stdin":   {[]string{"-point", "ask"}, "  \n"},
		"stdin too big": {[]string{"-point", "ask"}, strings.Repeat("x", maxState+1)},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			var out, errOut bytes.Buffer
			if code := run(tc.args, strings.NewReader(tc.stdin), &out, &errOut, env{}.get); code != 2 {
				t.Errorf("code %d, want 2", code)
			}
			if out.Len() != 0 {
				t.Errorf("a wrong call prints no answer line, got %q", out.String())
			}
		})
	}
}

// ask and decided share the text: both columns of "asked in vain" and
// "should have asked" must be the same question.
func TestAskAndDecidedShareTheQuestion(t *testing.T) {
	t.Parallel()
	if questions["ask"].Instructions != questions["decided"].Instructions {
		t.Error("ask and decided must ask the same question")
	}
	if len(questionsVersion()) != 8 {
		t.Errorf("version %q, want 8 hex chars", questionsVersion())
	}
}
