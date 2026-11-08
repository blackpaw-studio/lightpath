.PHONY: ui build test e2e install-test snapshot

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

install-test:
	sh install_test.sh
	shellcheck install_test.sh ui/public/install.sh

# Local GoReleaser build, no publish: archives land in dist/.
snapshot:
	goreleaser release --snapshot --clean
