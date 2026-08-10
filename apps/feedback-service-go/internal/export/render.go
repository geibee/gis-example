package export

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var formulaPrefix = regexp.MustCompile(`^[\x00-\x20]*[=+\-@]`)

func EscapeSpreadsheetValue(value string) string {
	if formulaPrefix.MatchString(value) {
		return "'" + value
	}
	return value
}

func Render(format, locale, timezone string, rows []Row) ([]byte, error) {
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, invalid("request.invalid", "timezone はIANA timezone IDで指定してください")
	}
	labels := []string{
		"Thread ID", "Number", "Session ID", "Status", "Perspective", "Page", "Route", "Target",
		"Reporter", "Messages", "Latest message", "Application link", "Evidence", "Created at", "Updated at",
	}
	if strings.HasPrefix(strings.ToLower(locale), "ja") {
		labels = []string{
			"スレッドID", "番号", "セッションID", "状態", "観点", "ページ", "ルート", "対象種別",
			"投稿者", "メッセージ数", "最新メッセージ", "対象アプリへのリンク", "証跡", "作成日時", "更新日時",
		}
	}
	values := make([][]string, 0, len(rows)+1)
	values = append(values, labels)
	for _, row := range rows {
		createdAt, err := time.Parse(time.RFC3339Nano, row.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("createdAtが不正です: %w", err)
		}
		updatedAt, err := time.Parse(time.RFC3339Nano, row.UpdatedAt)
		if err != nil {
			return nil, fmt.Errorf("updatedAtが不正です: %w", err)
		}
		line := []string{
			row.ThreadID, fmt.Sprint(row.DisplayNumber), row.SessionID, row.Status, row.PerspectiveCode,
			row.PageKey, row.RouteTemplate, row.TargetKind, row.ReporterName, fmt.Sprint(row.MessageCount),
			row.LatestMessage, row.DeepLink, fmt.Sprint(row.EvidenceAvailable),
			formatExportTime(createdAt, location), formatExportTime(updatedAt, location),
		}
		for index := range line {
			line[index] = EscapeSpreadsheetValue(line[index])
		}
		values = append(values, line)
	}
	switch format {
	case FormatCSV:
		return renderCSV(values), nil
	case FormatXLSX:
		return renderXLSX(values)
	default:
		return nil, fmt.Errorf("未対応のexport formatです: %s", format)
	}
}

func formatExportTime(value time.Time, location *time.Location) string {
	return value.In(location).Format("2006-01-02 15:04:05") + " " + location.String()
}

func renderCSV(rows [][]string) []byte {
	var output strings.Builder
	output.WriteString("\ufeff")
	for _, row := range rows {
		for index, value := range row {
			if index > 0 {
				output.WriteByte(',')
			}
			output.WriteByte('"')
			output.WriteString(strings.ReplaceAll(value, `"`, `""`))
			output.WriteByte('"')
		}
		output.WriteString("\r\n")
	}
	return []byte(output.String())
}

func renderXLSX(rows [][]string) ([]byte, error) {
	entries := []struct{ name, value string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Feedback" sheetId="1" r:id="rId1"/></sheets>
</workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`},
	}
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sheet.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIndex, row := range rows {
		fmt.Fprintf(&sheet, `<row r="%d">`, rowIndex+1)
		for columnIndex, value := range row {
			fmt.Fprintf(&sheet, `<c r="%s%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`,
				columnName(columnIndex), rowIndex+1, escapeXML(value))
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	entries = append(entries, struct{ name, value string }{"xl/worksheets/sheet1.xml", sheet.String()})
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	for _, entry := range entries {
		writer, err := archive.Create(entry.name)
		if err != nil {
			return nil, err
		}
		if _, err := writer.Write([]byte(strings.ReplaceAll(entry.value, `\"`, `"`))); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func columnName(index int) string {
	value := index + 1
	var result string
	for value > 0 {
		result = string(rune('A'+(value-1)%26)) + result
		value = (value - 1) / 26
	}
	return result
}

func escapeXML(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return replacer.Replace(value)
}

type manifestRoute struct {
	PageKey         string                       `json:"pageKey"`
	Template        string                       `json:"template"`
	Aliases         []string                     `json:"aliases"`
	Parameters      map[string]persistencePolicy `json:"parameters"`
	QueryParameters map[string]persistencePolicy `json:"queryParameters"`
}

type persistencePolicy struct {
	Persistence string `json:"persistence"`
}

type exportManifest struct {
	Routes []manifestRoute `json:"routes"`
}

type exportLocation struct {
	PageKey         string            `json:"pageKey"`
	RouteTemplate   string            `json:"routeTemplate"`
	PathParameters  map[string]string `json:"pathParameters"`
	QueryParameters map[string]string `json:"queryParameters"`
}

func BuildDeepLink(baseURL, threadParameter string, manifestJSON, locationJSON []byte, threadID string) (string, error) {
	var manifest exportManifest
	var location exportLocation
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return "", err
	}
	if err := json.Unmarshal(locationJSON, &location); err != nil {
		return "", err
	}
	queryParameters, err := orderedStringObject(locationJSON, "queryParameters")
	if err != nil {
		return "", err
	}
	fallback := strings.TrimRight(baseURL, "/") + "/"
	var selected *manifestRoute
	for index := range manifest.Routes {
		route := &manifest.Routes[index]
		if route.PageKey == location.PageKey && (route.Template == location.RouteTemplate || contains(route.Aliases, location.RouteTemplate)) {
			selected = route
			break
		}
	}
	if selected == nil {
		return appendQuery(fallback, [][2]string{{threadParameter, threadID}}), nil
	}
	path := location.RouteTemplate
	parameterPattern := regexp.MustCompile(`\{([A-Za-z_][A-Za-z0-9_]*)}`)
	unsafe := false
	path = parameterPattern.ReplaceAllStringFunc(path, func(match string) string {
		name := parameterPattern.FindStringSubmatch(match)[1]
		value, exists := location.PathParameters[name]
		if !exists || selected.Parameters[name].Persistence != "store" || strings.HasPrefix(value, "sha256:") {
			unsafe = true
			return match
		}
		return encodeQuery(value)
	})
	if unsafe {
		return appendQuery(fallback, [][2]string{{threadParameter, threadID}}), nil
	}
	query := make([][2]string, 0, len(queryParameters)+1)
	for _, parameter := range queryParameters {
		name, value := parameter[0], parameter[1]
		if selected.QueryParameters[name].Persistence == "store" {
			query = append(query, [2]string{name, value})
		}
	}
	query = append(query, [2]string{threadParameter, threadID})
	return appendQuery(strings.TrimRight(baseURL, "/")+path, query), nil
}

// orderedStringObject はkotlinx.serialization JsonObjectの入力順反復を維持する。
func orderedStringObject(raw []byte, property string) ([][2]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("JSON rootがobjectではありません")
	}
	for decoder.More() {
		nameToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if nameToken != property {
			continue
		}
		object := json.NewDecoder(bytes.NewReader(value))
		start, err := object.Token()
		if err != nil {
			return nil, err
		}
		if delimiter, ok := start.(json.Delim); !ok || delimiter != '{' {
			return nil, fmt.Errorf("%sがobjectではありません", property)
		}
		result := make([][2]string, 0)
		for object.More() {
			key, err := object.Token()
			if err != nil {
				return nil, err
			}
			var text string
			if err := object.Decode(&text); err != nil {
				return nil, err
			}
			result = append(result, [2]string{key.(string), text})
		}
		return result, nil
	}
	return nil, nil
}

func appendQuery(raw string, values [][2]string) string {
	separator := "?"
	if strings.Contains(raw, "?") {
		separator = "&"
	}
	var output strings.Builder
	output.WriteString(raw)
	output.WriteString(separator)
	for index, item := range values {
		if index > 0 {
			output.WriteByte('&')
		}
		output.WriteString(encodeQuery(item[0]))
		output.WriteByte('=')
		output.WriteString(encodeQuery(item[1]))
	}
	return output.String()
}

func encodeQuery(value string) string { return strings.ReplaceAll(url.QueryEscape(value), "+", "%20") }

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
