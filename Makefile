.PHONY: ui build test e2e

ui:
	cd ui && npm ci && npm run build

build: ui
	go build -o lightpath ./cmd/lightpath

test:
	go vet ./...
	go test ./...
	cd ui && npx tsc --noEmit && npx eslint . && npx vitest run

e2e: build
	cd ui && npx playwright test
