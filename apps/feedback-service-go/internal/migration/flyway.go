package migration

import (
	"bufio"
	"bytes"
	"fmt"
	"hash/crc32"
)

// FlywayDefinition はFeedback本体とは別schemaで管理する固定Flyway migrationを表す。
type FlywayDefinition struct {
	Version     int64
	Script      string
	Description string
	SQL         string
	Checksum    int32
	SHA256      string
}

// FlywayChecksum はFlywayのUTF-8行単位CRC32 checksumを計算する。
// 改行byte自体はchecksumへ含めないため、末尾LFの有無は結果へ影響しない。
func FlywayChecksum(contents []byte) (int32, error) {
	hash := crc32.NewIEEE()
	scanner := bufio.NewScanner(bytes.NewReader(contents))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		if _, err := hash.Write(scanner.Bytes()); err != nil {
			return 0, fmt.Errorf("対象Flyway checksumを計算できません: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("対象Flyway checksumを計算できません: %w", err)
	}
	return int32(hash.Sum32()), nil
}
