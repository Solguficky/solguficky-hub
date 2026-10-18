package server

import (
	"strings"
	"testing"
)

// adsCode — код канала, общий для тестов реестра.
const adsCode = "tg_ads"

func TestSourceChannelCodeFollowsDeepLinkPayload(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		adsCode:                 true,
		"TikTok-Sept":           true,
		strings.Repeat("a", 62): true,
		"":                      false,
		strings.Repeat("a", 63): false,
		"tg ads":                false,
		"tg.ads":                false,
		"канал":                 false,
		"s_tg_ads\n":            false,
	}
	for code, want := range cases {
		if got := validSourceChannelCode(code); got != want {
			t.Errorf("validSourceChannelCode(%q) = %v, want %v", code, got, want)
		}
	}
}

// zeroWidthSpace — невидимый символ, который strings.TrimSpace не снимает.
var zeroWidthSpace = string(rune(0x200b))

func TestSourceChannelLabelIsTrimmedAndBounded(t *testing.T) {
	t.Parallel()
	if got, err := normalizeSourceChannelLabel("  Солегуфики  "); err != nil || got != "Солегуфики" {
		t.Fatalf("normalize = %q %v", got, err)
	}
	// Граница считается в символах, а не в байтах: кириллица — два байта.
	if _, err := normalizeSourceChannelLabel(strings.Repeat("ж", 64)); err != nil {
		t.Fatalf("64 runes: %v", err)
	}
	for _, label := range []string{"", "   ", strings.Repeat("ж", 65), "Реклама\n\nв TG", zeroWidthSpace, "Рек" + zeroWidthSpace + "лама"} {
		if _, err := normalizeSourceChannelLabel(label); err == nil {
			t.Errorf("label %q accepted", label)
		}
	}
}

// Код, которого нет, и код чужого формата разрешаются без базы: запрос к
// реестру нужен только коду, который мог бы быть каналом. Нулевой querier
// уронил бы тест, если бы до него дошло.
func TestApplicationSourceWithoutLookup(t *testing.T) {
	t.Parallel()
	none, err := resolveApplicationSource(t.Context(), nil, nil)
	if err != nil || none.channel.Valid || none.unknown {
		t.Fatalf("no code = %+v %v, want no source", none, err)
	}
	for _, code := range []string{"", "tg.ads", strings.Repeat("a", 63)} {
		source, err := resolveApplicationSource(t.Context(), nil, &code)
		if err != nil || source.channel.Valid || !source.unknown {
			t.Errorf("code %q = %+v %v, want unknown source", code, source, err)
		}
	}
}
