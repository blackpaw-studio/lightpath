.PHONY: ui build test e2e

GO_PKGS = $$(go list ./... | grep -v /node_modules/)

ui:
	cd ui && npm ci && npm run build

build: ui
	go build -o lightpath ./cmd/lightpath

test:
	go vet $(GO_PKGS)
	go test $(GO_PKGS)
	cd ui && npx tsc --noEmit && npx eslint . && npx vitest run

e2e: build
	cd ui && npx playwright test
