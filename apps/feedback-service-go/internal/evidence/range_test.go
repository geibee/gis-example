package evidence

import (
	"errors"
	"net/http"
	"reflect"
	"testing"
)

func TestParseByteRange(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		raw   string
		total int64
		want  ByteRange
		valid bool
	}{
		{name: "closed", raw: "bytes=2-5", total: 10, want: ByteRange{First: 2, Last: 5}, valid: true},
		{name: "suffix", raw: "bytes=-3", total: 10, want: ByteRange{First: 7, Last: 9}, valid: true},
		{name: "large suffix", raw: "bytes=-30", total: 10, want: ByteRange{First: 0, Last: 9}, valid: true},
		{name: "open", raw: "bytes=8-", total: 10, want: ByteRange{First: 8, Last: 9}, valid: true},
		{name: "clamped", raw: "bytes=8-30", total: 10, want: ByteRange{First: 8, Last: 9}, valid: true},
		{name: "out of bounds", raw: "bytes=10-11", total: 10},
		{name: "multiple", raw: "bytes=0-1,3-4", total: 10},
		{name: "wrong unit", raw: "Bytes=0-1", total: 10},
		{name: "zero suffix", raw: "bytes=-0", total: 10},
		{name: "reversed", raw: "bytes=4-2", total: 10},
		{name: "empty total", raw: "bytes=0-", total: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParseByteRange(test.raw, test.total)
			if test.valid {
				if err != nil || got != test.want {
					t.Fatalf("ParseByteRange()=%+v error=%v want=%+v", got, err, test.want)
				}
				return
			}
			if !errors.Is(err, ErrRangeNotSatisfiable) {
				t.Fatalf("error=%v, want ErrRangeNotSatisfiable", err)
			}
		})
	}
}

func TestPrepareHTTPDownload(t *testing.T) {
	t.Parallel()
	input := validInput()
	full, err := PrepareHTTPDownload(Download{ContentType: input.ContentType, Data: input.Data}, nil)
	if err != nil || full.Status != http.StatusOK || !reflect.DeepEqual(full.Body, input.Data) ||
		full.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("full=%+v error=%v", full, err)
	}
	raw := "bytes=1-3"
	partial, err := PrepareHTTPDownload(Download{ContentType: input.ContentType, Data: input.Data}, &raw)
	if err != nil || partial.Status != http.StatusPartialContent ||
		partial.Header.Get("Content-Range") != "bytes 1-3/15" || !reflect.DeepEqual(partial.Body, input.Data[1:4]) {
		t.Fatalf("partial=%+v error=%v", partial, err)
	}
	invalid := ""
	if _, err := PrepareHTTPDownload(Download{ContentType: input.ContentType, Data: input.Data}, &invalid); !errors.Is(err, ErrRangeNotSatisfiable) {
		t.Fatalf("empty Range error=%v", err)
	}
}
