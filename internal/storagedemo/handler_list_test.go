package storagedemo

import "testing"

func TestDetectMimeType(t *testing.T) {
	tests := []struct {
		name     string
		expected string
	}{
		{"welcome.md", "text/markdown"},
		{"page.html", "text/html"},
		{"index.htm", "text/html"},
		{"script.py", "text/x-python"},
		{"app.jsx", "text/jsx"},
		{"main.js", "text/javascript"},
		{"component.tsx", "text/tsx"},
		{"main.ts", "text/typescript"},
		{"styles.css", "text/css"},
		{"config.json", "application/json"},
		{"data.xml", "application/xml"},
		{"config.yaml", "text/yaml"},
		{"config.yml", "text/yaml"},
		{"main.go", "text/x-go"},
		{"lib.rs", "text/x-rust"},
		{"App.java", "text/x-java"},
		{"readme.txt", "text/plain"},
		{"unknown.xyz", "text/plain"},
		{"noextension", "text/plain"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectMimeType(tt.name)
			if got != tt.expected {
				t.Errorf("detectMimeType(%q) = %q, want %q", tt.name, got, tt.expected)
			}
		})
	}
}
