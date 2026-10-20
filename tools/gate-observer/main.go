// Command gate-observer asks decision models the question of a manual gate
// point and prints P(yes) of each next to the agent's own answer.
//
// The models only observe: the agent has already decided when this runs, and
// nothing here feeds back into the decision. Each provider fails on its own —
// a missing key, a network error or an unexpected answer prints "недоступен"
// in its column and the other column still answers. The exit code is 0 in
// every such case, so a delivery never stops on an observer; 2 means a wrong
// call.
//
// Usage:
//
//	gate-observer -point ask|plan|decided [-dry-run] [-timeout 20s] < decision.txt
//
// Stdin is the decision and its sources, as the agent wrote them for the
// report. It is the only content that leaves the machine.
//
// Environment:
//
//	TYPESAFE_API_KEY            Jev; no key — the Jev column is "недоступен"
//	CF_API_TOKEN, CF_ACCOUNT_ID Clef on Workers AI; either missing — the Clef
//	                            column is "недоступен"
//	JEV_URL, CLEF_URL           endpoint overrides; only the tests set them
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// maxState bounds what goes out: a gate line with its sources fits easily, a
// pasted diff or log does not belong in a request to a third party.
const maxState = 8 << 10

const questionID = "gate"

type question struct {
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

// questions holds one question per gate point. ask and decided share the
// text on purpose: "asked in vain" and "should have asked" are then measured
// on the same scale. Changing any text changes questionsVersion, which every
// output line carries, so lines of different generations stay apart.
var questions = map[string]question{
	"ask":     resolvedQuestion,
	"decided": resolvedQuestion,
	"plan": {
		Instructions: "Задевает ли план из `state` межсервисный контракт, принятый ADR, схему базы данных или второй компонент репозитория?",
		Criteria: map[string]string{
			"true":  "План меняет контракт, ADR, схему данных или код второго компонента.",
			"false": "План остаётся внутри одного компонента и не трогает контракт, ADR и схему.",
		},
	},
}

var resolvedQuestion = question{
	Instructions: "Разрешено ли решение из `state` уже постановкой задачи, принятыми ADR или политикой контура исполнения, так что агент вправе принять его сам, не спрашивая владельца?",
	Criteria: map[string]string{
		"true":  "Решение прямо покрыто задачей, ADR или политикой контура и не выходит за их границы.",
		"false": "Решение — новое продуктовое поведение, выход за границы задачи, расхождение с планом, необратимое действие, деньги вне подписок или новая внешняя зависимость.",
	},
}

func questionsVersion() string {
	points := make([]string, 0, len(questions))
	for p := range questions {
		points = append(points, p)
	}
	sort.Strings(points)
	h := sha256.New()
	for _, p := range points {
		q := questions[p]
		_, _ = fmt.Fprintf(h, "%s\x00%s\x00%s\x00%s\x00", p, q.Instructions, q.Criteria["true"], q.Criteria["false"])
	}
	return hex.EncodeToString(h.Sum(nil))[:8]
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr, os.Getenv))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer, getenv func(string) string) int {
	fs := flag.NewFlagSet("gate-observer", flag.ContinueOnError)
	fs.SetOutput(stderr)
	point := fs.String("point", "", "gate point: ask, plan or decided")
	dryRun := fs.Bool("dry-run", false, "print the request body and send nothing")
	timeout := fs.Duration("timeout", 20*time.Second, "per-provider timeout")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	q, ok := questions[*point]
	if !ok {
		say(stderr, "gate-observer: -point must be ask, plan or decided\n")
		return 2
	}
	raw, err := io.ReadAll(io.LimitReader(stdin, maxState+1))
	if err != nil {
		say(stderr, "gate-observer: read stdin: %v\n", err)
		return 2
	}
	if len(raw) > maxState {
		say(stderr, "gate-observer: stdin over %d bytes — pass the decision and its sources, not a diff or a log\n", maxState)
		return 2
	}
	state := strings.TrimSpace(string(raw))
	if state == "" {
		say(stderr, "gate-observer: stdin is empty — pass the decision and its sources\n")
		return 2
	}

	providers := []provider{jev(getenv), clef(getenv)}
	if *dryRun {
		for _, p := range providers {
			body, err := requestBody(p.model, state, q)
			if err != nil {
				say(stderr, "gate-observer: %v\n", err)
				return 2
			}
			say(stdout, "%s → %s\n%s\n", p.name, p.endpoint, body)
		}
		return 0
	}

	answers := make([]answer, len(providers))
	var wg sync.WaitGroup
	for i, p := range providers {
		wg.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), *timeout)
			defer cancel()
			answers[i] = p.ask(ctx, state, q)
		})
	}
	wg.Wait()

	cols := make([]string, 0, len(answers)+1)
	for i, a := range answers {
		cols = append(cols, a.column(providers[i].name))
	}
	cols = append(cols, fmt.Sprintf("вопрос %s@%s", *point, questionsVersion()))
	say(stdout, "%s\n", strings.Join(cols, " | "))
	return 0
}

type answer struct {
	p       float64
	model   string
	failure error
}

func (a answer) column(name string) string {
	if a.failure != nil {
		return fmt.Sprintf("%s недоступен (%v)", name, a.failure)
	}
	model := a.model
	if model == "" {
		model = "версия не отдана"
	}
	return fmt.Sprintf("%s %.2f (%s)", name, a.p, model)
}

var errNoKey = errors.New("нет ключа")

// say writes a line nobody can act on failing: stdout and stderr of a CLI.
func say(w io.Writer, format string, a ...any) {
	_, _ = fmt.Fprintf(w, format, a...)
}
