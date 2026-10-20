package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
)

// Jev and Clef speak the same SystemOne request: one state, typed questions
// keyed by id. They differ in endpoint, credentials and where the answers sit
// in the reply — Workers AI wraps them in its standard `result` envelope.
type provider struct {
	name     string
	endpoint string
	model    string
	token    string
	missing  string
}

func jev(getenv func(string) string) provider {
	p := provider{
		name:     "Jev",
		endpoint: "https://api.typesafe.ai/v1/systemone",
		model:    "jev-latest",
		token:    getenv("TYPESAFE_API_KEY"),
	}
	if p.token == "" {
		p.missing = "TYPESAFE_API_KEY"
	}
	if u := getenv("JEV_URL"); u != "" {
		p.endpoint = u
	}
	return p
}

func clef(getenv func(string) string) provider {
	account := getenv("CF_ACCOUNT_ID")
	p := provider{
		name:     "Clef",
		endpoint: "https://api.cloudflare.com/client/v4/accounts/" + account + "/ai/run/@cf/cloudflare/clef",
		model:    "clef",
		token:    getenv("CF_API_TOKEN"),
	}
	switch {
	case p.token == "":
		p.missing = "CF_API_TOKEN"
	case account == "":
		p.missing = "CF_ACCOUNT_ID"
	}
	if u := getenv("CLEF_URL"); u != "" {
		p.endpoint = u
	}
	return p
}

type noulQuestion struct {
	Type string `json:"type"`
	question
}

func requestBody(model, state string, q question) ([]byte, error) {
	return json.MarshalIndent(struct {
		Model     string                  `json:"model"`
		State     string                  `json:"state"`
		Questions map[string]noulQuestion `json:"questions"`
	}{
		Model:     model,
		State:     state,
		Questions: map[string]noulQuestion{questionID: {Type: "noul", question: q}},
	}, "", "  ")
}

type answers struct {
	Model   string `json:"model"`
	Answers map[string]struct {
		Type string   `json:"type"`
		Noul *float64 `json:"noul"`
	} `json:"answers"`
}

func (p provider) ask(ctx context.Context, state string, q question) answer {
	if p.missing != "" {
		return answer{failure: fmt.Errorf("%w %s", errNoKey, p.missing)}
	}
	body, err := requestBody(p.model, state, q)
	if err != nil {
		return answer{failure: err}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint, bytes.NewReader(body))
	if err != nil {
		return answer{failure: errors.New("адрес не разобран")}
	}
	req.Header.Set("Authorization", "Bearer "+p.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// The error text carries the URL, and Clef's URL carries the account
		// id; the reason alone is enough for the report.
		if ctx.Err() != nil {
			return answer{failure: errors.New("таймаут")}
		}
		return answer{failure: errors.New("сеть")}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return answer{failure: errors.New("ответ не прочитан")}
	}
	if resp.StatusCode != http.StatusOK {
		return answer{failure: fmt.Errorf("HTTP %d", resp.StatusCode)}
	}
	return parse(raw)
}

// parse accepts both shapes: Jev's bare answers and Clef's `result` envelope.
func parse(raw []byte) answer {
	var envelope struct {
		Result *answers `json:"result"`
		answers
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return answer{failure: errors.New("ответ не JSON")}
	}
	a := envelope.answers
	if envelope.Result != nil {
		a = *envelope.Result
	}
	got, ok := a.Answers[questionID]
	if !ok || got.Type != "noul" || got.Noul == nil {
		return answer{failure: errors.New("в ответе нет noul")}
	}
	p := *got.Noul
	if math.IsNaN(p) || p < 0 || p > 1 {
		return answer{failure: errors.New("вероятность вне 0..1")}
	}
	return answer{p: p, model: a.Model}
}
