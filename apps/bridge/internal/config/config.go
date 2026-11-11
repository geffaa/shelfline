// Package config holds what the bridge learns when it is paired, and the pairing call itself.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	Server   string `json:"server"`
	BridgeID string `json:"bridgeId"`
	Secret   string `json:"secret"`
	Location string `json:"location"`
	Timezone string `json:"timezone"`
}

func path(dir string) string { return filepath.Join(dir, "config.json") }

func Load(dir string) (*Config, error) {
	b, err := os.ReadFile(path(dir))
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) Save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path(dir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil { // the signing key is a secret: owner-only
		return err
	}
	return os.Rename(tmp, path(dir))
}

var ErrNotPaired = errors.New("not paired")

// Pair exchanges a short pairing code from the back office for this bridge's identity and signing key.
func Pair(server, code string, client *http.Client) (*Config, error) {
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	body, _ := json.Marshal(map[string]string{"pairingCode": code})
	res, err := client.Post(server+"/devices/pair", "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("pairing refused (%d): the code may be wrong, used or expired", res.StatusCode)
	}
	var out struct {
		BridgeID, Secret, Location, Timezone string
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return &Config{Server: server, BridgeID: out.BridgeID, Secret: out.Secret, Location: out.Location, Timezone: out.Timezone}, nil
}
