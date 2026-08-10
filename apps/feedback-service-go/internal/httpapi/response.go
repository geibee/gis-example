package httpapi

import "net/http"

// ResponseObserver はmiddleware間でstatusとresponse byte数を観測する。
// http.ResponseControllerが元のwriterへ到達できるようUnwrapを提供する。
type ResponseObserver struct {
	http.ResponseWriter
	status int
	bytes  int64
}

// ObserveResponse は未commitのresponse observerを返す。
func ObserveResponse(writer http.ResponseWriter) *ResponseObserver {
	return &ResponseObserver{ResponseWriter: writer}
}

// WriteHeader は最初のstatusだけを記録する。
func (writer *ResponseObserver) WriteHeader(status int) {
	if writer.status != 0 {
		return
	}
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

// Write は暗黙の200応答と実際に書き込めたbyte数を記録する。
func (writer *ResponseObserver) Write(body []byte) (int, error) {
	if writer.status == 0 {
		writer.WriteHeader(http.StatusOK)
	}
	written, err := writer.ResponseWriter.Write(body)
	writer.bytes += int64(written)
	return written, err
}

// Unwrap はhttp.ResponseControllerへ元のwriterを公開する。
func (writer *ResponseObserver) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

// Status は観測したstatusを返し、未commitなら200を返す。
func (writer *ResponseObserver) Status() int {
	if writer.status == 0 {
		return http.StatusOK
	}
	return writer.status
}

// BytesWritten は実際に書き込めたresponse byte数を返す。
func (writer *ResponseObserver) BytesWritten() int64 { return writer.bytes }

// Committed はheaderまたはbodyが書き込まれたかを返す。
func (writer *ResponseObserver) Committed() bool { return writer.status != 0 }
