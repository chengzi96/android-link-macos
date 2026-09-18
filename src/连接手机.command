#!/bin/zsh -f
RESOURCE_DIR="${0:A:h}"
exec /bin/zsh -f "$RESOURCE_DIR/bootstrap.zsh" menu
