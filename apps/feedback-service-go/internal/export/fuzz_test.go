package export

import (
	"encoding/csv"
	"io"
	"strings"
	"testing"
)

func FuzzRenderCSV(f *testing.F) {
	for _, seed := range []string{
		"plain",
		`value,"quoted"`,
		"line1\r\nline2",
		`=HYPERLINK("https://attacker.invalid")`,
		" \t+SUM(A1:A2)",
		"日本語とemoji😀",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if len(value) > 64*1024 {
			t.Skip()
		}
		escaped := EscapeSpreadsheetValue(value)
		if formulaPrefix.MatchString(value) {
			if escaped != "'"+value || formulaPrefix.MatchString(escaped) {
				t.Fatalf("formula escapeが不正です: input=%q escaped=%q", value, escaped)
			}
		} else if escaped != value {
			t.Fatalf("安全な値が変更されました: input=%q escaped=%q", value, escaped)
		}

		encoded := renderCSV([][]string{{escaped}})
		const bom = "\ufeff"
		if !strings.HasPrefix(string(encoded), bom) || !strings.HasSuffix(string(encoded), "\r\n") {
			t.Fatalf("CSV framingが不正です: %q", encoded)
		}
		reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(encoded), bom)))
		record, err := reader.Read()
		if err != nil {
			t.Fatalf("生成CSVを読み戻せません: %v", err)
		}
		// encoding/csvはquoted field内もCRLFをLFへ正規化する。
		roundTripExpected := strings.ReplaceAll(escaped, "\r\n", "\n")
		if len(record) != 1 || record[0] != roundTripExpected {
			t.Fatalf("CSV round tripが不一致です: got=%q want=%q", record, roundTripExpected)
		}
		if _, err := reader.Read(); err != io.EOF {
			t.Fatalf("生成CSVに余分なrecordがあります: %v", err)
		}
	})
}
