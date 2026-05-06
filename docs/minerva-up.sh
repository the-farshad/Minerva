#!/usr/bin/env bash
# Backwards-compat shim. Everything moved into minerva-services.py up.
exec python3 "$(dirname "$0")/minerva-services.py" up "${MINERVA_BROWSER:-firefox}" "$@"
