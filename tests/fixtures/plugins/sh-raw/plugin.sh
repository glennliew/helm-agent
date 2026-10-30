#!/bin/sh
# A complete Helm plugin in POSIX sh, using only shell builtins: proof that the protocol, not an
# SDK, is the contract. It answers initialize, one tool, shutdown and exit; everything else that
# expects a reply gets "method not found". Host request ids are JSON strings such as "h1".
while IFS= read -r line; do
  case "$line" in *'"id":'*) id=${line#*\"id\":}; id=${id%%,*} ;; *) id= ;; esac
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"1.0","capabilities":{"tools":["shout"],"commands":[],"hooks":[],"panels":[],"providers":[]}}}\n' "$id" ;;
    *'"method":"tool/invoke"'*)
      text=${line#*\"text\":\"}; text=${text%%\"*}
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s! (from sh)"}]}}\n' "$id" "$text" ;;
    *'"method":"shutdown"'*) printf '{"jsonrpc":"2.0","id":%s,"result":null}\n' "$id" ;;
    *'"method":"exit"'*) exit 0 ;;
    *) [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"not implemented"}}\n' "$id" ;;
  esac
done
