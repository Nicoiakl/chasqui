#!/bin/bash
# Comprueba TODO lo que la casa anuncia. Doce despliegues en un día rompen cosas en silencio.
ok=0; mal=0
p() { if [ "$2" = "$3" ]; then printf "  ✓ %-42s %s\n" "$1" "$2"; ok=$((ok+1)); else printf "  ✗ %-42s %s (se esperaba %s)\n" "$1" "$2" "$3"; mal=$((mal+1)); fi; }
c() { curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$1"; }

echo "SUPERFICIES PÚBLICAS"
for u in / /spec /app /report /report.json /llms.txt /robots.txt /sitemap.xml /favicon.ico /og.png /tareas /health /.well-known/nyx5.json; do
  p "GET $u" "$(c https://nyx5.com$u)" 200
done
p "GET /es (retirado)" "$(c https://nyx5.com/es)" 404
p "GET /terms (apagado)" "$(c https://nyx5.com/terms)" 404
p "HEAD /" "$(curl -s -o /dev/null -w '%{http_code}' -I https://nyx5.com/)" 200
p "www -> apex (301)" "$(curl -s -o /dev/null -w '%{http_code}' --resolve "www.nyx5.com:443:$(dig +short @1.1.1.1 www.nyx5.com A | head -1)" https://www.nyx5.com/)" 301
p "http -> https (301)" "$(curl -s -o /dev/null -w '%{http_code}' http://nyx5.com/)" 301

echo "x402"
p "GET /x402/supported" "$(c https://nyx5.com/x402/supported)" 200
# Un buzón de sistema no cobra: la respuesta correcta es 200 diciendo que es gratis, no un error.
p "GET /x402/inbox/libro (gratis)" "$(c https://nyx5.com/x402/inbox/libro)" 200
p "GET /x402/inbox/nadie" "$(c https://nyx5.com/x402/inbox/nadie)" 404
# Lo que anunciamos tiene que ser un identificador CAIP-2 real, no una cadena parecida.
red=$(curl -s --max-time 12 https://nyx5.com/x402/supported | grep -o '"network":"[^"]*"' | head -1 | cut -d'"' -f4)
p "red CAIP-2 declarada" "$(echo "$red" | grep -qE '^[-a-z0-9]{3,8}:[-_A-Za-z0-9]{1,32}$' && echo ok || echo "$red")" ok

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
