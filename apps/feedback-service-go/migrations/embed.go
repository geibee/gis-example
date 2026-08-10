// Package migrations はGo migratorが所有するV7以降のSQLをbinaryへ埋め込む。
package migrations

import (
	"embed"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/migration"
)

// sourceにはREADMEと将来追加するV7以降のSQLだけが含まれる。
//
//go:embed *
var source embed.FS

func Load() ([]migration.Definition, error) { return migration.LoadDefinitions(source) }
