package evidence

import "testing"

func FuzzDecodeBase64(f *testing.F) {
	for _, seed := range []string{"", "aGVsbG8=", "aGVsbG8", "aG Vs", "===="} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		decoded, err := DecodeBase64(raw, 1024)
		if err == nil && len(decoded) > 1024 {
			t.Fatalf("上限を超えるbase64を受理しました: %d", len(decoded))
		}
	})
}

func FuzzParseByteRange(f *testing.F) {
	for _, seed := range []string{"bytes=0-0", "bytes=1-", "bytes=-10", "bytes=0-1,2-3", ""} {
		f.Add(seed, int64(100))
	}
	f.Fuzz(func(t *testing.T, raw string, total int64) {
		if total < 1 || total > 1<<30 {
			total = 100
		}
		selected, err := ParseByteRange(raw, total)
		if err == nil && (selected.First < 0 || selected.Last < selected.First || selected.Last >= total || selected.Length() < 1) {
			t.Fatalf("範囲外の結果です: total=%d range=%+v", total, selected)
		}
	})
}
