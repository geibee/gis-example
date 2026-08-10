package httpapi

import "testing"

func FuzzCanonicalJSONSHA256(f *testing.F) {
	for _, seed := range [][]byte{
		[]byte(`null`), []byte(`{"a":1,"b":[true,false]}`), []byte(`{"a":1}{"b":2}`), nil,
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		first, err := CanonicalJSONSHA256(raw)
		if err != nil {
			return
		}
		second, err := CanonicalJSONSHA256(raw)
		if err != nil || first != second || len(first) != 64 {
			t.Fatalf("canonical hashが安定していません: first=%q second=%q err=%v", first, second, err)
		}
	})
}
