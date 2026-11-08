Traceroute fixtures. Files without `synthetic` in the name are real captures from
2026-11-07 (stdout and stderr merged, as the runner reads them):

- `macos.reached.txt`, `macos.hostname.txt`: macOS (Darwin 27), `traceroute -n -q 3`. The header goes to stderr, hops to stdout. The hostname capture includes macOS's "multiple addresses" warning line.
- `linux.timeouts.txt`: Butskoy traceroute 2.1.6 (Debian stable) in Docker; only the first hop answers.

`*.synthetic.txt` are hand-written and start with a `# synthetic` line.
