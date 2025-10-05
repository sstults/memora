#!/usr/bin/env bash
set -euo pipefail
OS=${OS:-http://localhost:9200}
curl -s -XPUT "$OS/_index_template/mem-episodic" -H 'Content-Type: application/json' --data-binary @config/index-templates/mem-episodic.json
curl -s -XPUT "$OS/mem-semantic" -H 'Content-Type: application/json' --data-binary @config/index-templates/mem-semantic.json
curl -s -XPUT "$OS/mem-facts"    -H 'Content-Type: application/json' --data-binary @config/index-templates/mem-facts.json
echo "Indices ready."
