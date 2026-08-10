package export

import (
	"fmt"

	"github.com/google/uuid"
)

func canonicalUUID(value, name string) (string, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return "", invalid("request.invalid", fmt.Sprintf("%s は UUID で指定してください", name))
	}
	return parsed.String(), nil
}
