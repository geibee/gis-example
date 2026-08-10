package evidence

import (
	"net/http"
	"strconv"
	"strings"
)

type ByteRange struct {
	First int64
	Last  int64
}

func (value ByteRange) Length() int64 { return value.Last - value.First + 1 }

// ParseByteRange はKotlin v1と同じsingle byte rangeだけを解釈する。
func ParseByteRange(raw string, totalBytes int64) (ByteRange, error) {
	if totalBytes <= 0 || !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") {
		return ByteRange{}, rangeError(totalBytes)
	}
	value := strings.TrimSpace(strings.TrimPrefix(raw, "bytes="))
	separator := strings.IndexByte(value, '-')
	if separator < 0 {
		return ByteRange{}, rangeError(totalBytes)
	}
	firstRaw, lastRaw := value[:separator], value[separator+1:]
	if firstRaw == "" {
		suffix, err := strconv.ParseInt(lastRaw, 10, 64)
		if err != nil || suffix <= 0 {
			return ByteRange{}, rangeError(totalBytes)
		}
		return ByteRange{First: max(totalBytes-suffix, 0), Last: totalBytes - 1}, nil
	}
	first, err := strconv.ParseInt(firstRaw, 10, 64)
	if err != nil || first < 0 || first >= totalBytes {
		return ByteRange{}, rangeError(totalBytes)
	}
	last := totalBytes - 1
	if lastRaw != "" {
		last, err = strconv.ParseInt(lastRaw, 10, 64)
		if err != nil || last < first {
			return ByteRange{}, rangeError(totalBytes)
		}
		last = min(last, totalBytes-1)
	}
	return ByteRange{First: first, Last: last}, nil
}

type HTTPDownload struct {
	Status int
	Header http.Header
	Body   []byte
}

// PrepareHTTPDownload はerror応答を書き始める前にrangeを検証し、200/206 responseを組み立てる。
// requestedRange=nilはheaderなし、非nilの空文字列は不正なRange headerとして扱う。
func PrepareHTTPDownload(download Download, requestedRange *string) (HTTPDownload, error) {
	total := int64(len(download.Data))
	if total <= 0 || !matchesContentType(download.ContentType, download.Data) {
		return HTTPDownload{}, malformedIntegrity()
	}
	header := make(http.Header)
	header.Set("Accept-Ranges", "bytes")
	header.Set("Content-Disposition", "attachment; filename=feedback-evidence")
	header.Set("Content-Type", download.ContentType)
	if requestedRange == nil {
		header.Set("Content-Length", strconv.FormatInt(total, 10))
		return HTTPDownload{Status: http.StatusOK, Header: header, Body: download.Data}, nil
	}
	selected, err := ParseByteRange(*requestedRange, total)
	if err != nil {
		return HTTPDownload{}, err
	}
	body := download.Data[selected.First : selected.Last+1]
	header.Set("Content-Length", strconv.FormatInt(selected.Length(), 10))
	header.Set("Content-Range", "bytes "+strconv.FormatInt(selected.First, 10)+"-"+
		strconv.FormatInt(selected.Last, 10)+"/"+strconv.FormatInt(total, 10))
	return HTTPDownload{Status: http.StatusPartialContent, Header: header, Body: body}, nil
}

func rangeError(totalBytes int64) error {
	return domainError(
		ErrRangeNotSatisfiable,
		"evidence.range_not_satisfiable",
		"要求された byte range は evidence size "+strconv.FormatInt(totalBytes, 10)+" の範囲外です",
	)
}
