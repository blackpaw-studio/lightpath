.PHONY: ui build test e2e e2e-local install-test snapshot

GO_PKGS = $$(go list ./... | grep -v /node_modules/)

ui:
	cd ui && npm ci && npm run build

build: ui
	go build -o lightpath ./cmd/lightpath

test:
	go vet $(GO_PKGS)
	go test $(GO_PKGS)
	cd ui && npx tsc --noEmit && npx eslint . && npx vitest run

# Chromium and WebKit on the shared Playwright server (Apollo). Its browsers
# share an 8 GB cap: keep workers at 4 or fewer. Override PW_SERVER to point
# elsewhere. Screenshot comparisons are skipped remotely (darwin baselines).
PW_SERVER ?= ws://10.0.2.13:3000/
PW_WORKERS ?= 4

e2e: build
	cd ui && PW_TEST_CONNECT_WS_ENDPOINT='$(PW_SERVER)' PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' \
		npx playwright test --workers=$(PW_WORKERS) --project=chromium --project=webkit

# All three browsers on this machine, with darwin screenshot baselines. Heavy:
# on Dionysus run it as `heavy make e2e-local`.
e2e-local: build
	cd ui && npx playwright test --workers=$(PW_WORKERS) --project=chromium --project=webkit --project=firefox

install-test:
	sh install_test.sh
	shellcheck install_test.sh ui/public/install.sh

# Local GoReleaser build, no publish: archives land in dist/.
snapshot:
	goreleaser release --snapshot --clean
