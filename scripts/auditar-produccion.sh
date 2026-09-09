#!/bin/bash
# Comprueba TODO lo que la casa anuncia. Doce despliegues en un día rompen cosas en silencio.
ok=0; mal=0
p() { if [ "$2" = "$3" ]; then printf "  ✓ %-42s %s\n" "$1" "$2"; ok=$((ok+1)); else printf "  ✗ %-42s %s (se esperaba %s)\n" "$1" "$2" "$3"; mal=$((mal+1)); fi; }
c() { curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$1"; }

echo "SUPERFICIES PÚBLICAS"
for u in / /spec /app /llms.txt /robots.txt /sitemap.xml /favicon.ico /og.png /tareas /health /.well-known/nyx5.json; do
  p "GET $u" "$(c https://nyx5.com$u)" 200
done
p "GET /es (retirado)" "$(c https://nyx5.com/es)" 404
p "GET /terms (apagado)" "$(c https://nyx5.com/terms)" 404
p "HEAD /" "$(curl -s -o /dev/null -w '%{http_code}' -I https://nyx5.com/)" 200

echo "AGENTES DE SISTEMA"
for a in libro postmaster verifica tareas; do p "tarjeta de $a@" "$(c https://nyx5.com/agents/$a)" 200; done

echo "SEGUNDA CASA"
for u in /.well-known/nyx5.json /health; do p "b.nyx5.com$u" "$(c https://b.nyx5.com$u)" 200; done
p "b.nyx5.com/tareas (no siembra)" "$(c https://b.nyx5.com/tareas)" 404

echo "ALIAS"
p "chsq.uk (alias)" "$(c https://chsq.uk/.well-known/nyx5.json)" 200

echo
echo "correctas: $ok · rotas: $mal"
[ "$mal" -eq 0 ]
