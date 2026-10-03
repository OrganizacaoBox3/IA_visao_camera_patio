#!/usr/bin/env bash
# Custo por câmera nos apps de vídeo do Fly.
#
# MEDIÇÃO x INFERÊNCIA — o que cada número é:
#   MEDIDO   consumo (Prometheus do Fly) e inventário (flyctl): CPU, egress, volumes, IPs, nº de câmeras.
#   MEDIDO   perf-4x/8GB = US$197,00/mês e perf-2x/4GB = US$87,00/mês — lidos da fatura 01–15/09/2026,
#            dividindo cada item pelos dias em que aquele tamanho esteve no ar.
#   MEDIDO   volume US$0,15/GB/mês e IPv4 US$2,00/mês — o rateio da fatura bateu com a tabela oficial,
#            e é isso que valida o método de calibração inteiro.
#   INFERIDO shared-1x US$2,85/mês e RAM extra US$7,60/GB/mês — rateio da fatura pelo inventário;
#            ficam ~45% acima da tabela oficial (US$1,94 / US$5,00), provável markup de gru.
#   INFERIDO egress US$0,0372/GB — US$17,09 ÷ 459,5 GB do próprio período.
#
# RECALIBRAR quando a fatura mudar: Billing > Cost Explorer, e reabrir os valores abaixo.
set -uo pipefail

PRECO_PERF_VCPU_MES=49.25     # US$197,00 ÷ 4 vCPU
PRECO_SHARED_X_MES=2.85
PRECO_RAM_EXTRA_GB_MES=7.60
PRECO_VOLUME_GB_MES=0.15
PRECO_IPV4_MES=2.00
PRECO_EGRESS_GB=0.0372
ORG=personal
APPS=("${@:-visao-patio camhub-box3 camhub-test}")
APPS=(${APPS[@]})

TOKEN=$(flyctl auth token 2>/dev/null) || { echo "ERRO: sem token do flyctl"; exit 1; }
prom(){ curl -s -H "Authorization: FlyV1 $TOKEN" \
  "https://api.fly.io/prometheus/$ORG/api/v1/query" --data-urlencode "query=$1" \
  | jq -r '.data.result[0].value[1] // "0"'; }

# Conta câmeras pelo runtime. Devolve vazio (não zero) quando não consegue medir:
# dividir por um zero inventado seria falso-OK — o custo/câmera apareceria como infinito ou sumiria.
conta_cameras(){
  local app="$1" n=""
  case "$app" in
    visao-patio)
      n=$(flyctl logs -a "$app" --no-tail 2>/dev/null | grep -o '\[analysis\].*' | tail -1 \
          | tr '·' '\n' | grep -cE '^ *[A-Za-z0-9_-]+(\[g2r\])?:') ;;
    *)
      n=$(flyctl logs -a "$app" --no-tail 2>/dev/null \
          | grep -oE 'camera=[a-z0-9]+' | sort -u | wc -l | tr -d ' ') ;;
  esac
  [[ "$n" =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] && echo "$n"
}

printf '%-14s %8s %9s %9s %9s %9s %10s %12s\n' APP CAMS VM/mês EGRESS VOL IP TOTAL/mês POR-CÂMERA
printf '%s\n' "----------------------------------------------------------------------------------------------"

for app in "${APPS[@]}"; do
  maq=$(flyctl machines list -a "$app" --json 2>/dev/null \
        | jq -r '[.[] | select(.state=="started")][0] // empty')
  [ -z "$maq" ] && { printf '%-14s %8s  (nenhuma máquina ligada)\n' "$app" "-"; continue; }

  kind=$(jq -r '.config.guest.cpu_kind' <<<"$maq")
  cpus=$(jq -r '.config.guest.cpus' <<<"$maq")
  ram=$(jq -r '.config.guest.memory_mb' <<<"$maq")

  if [ "$kind" = "performance" ]; then
    vm=$(echo "$cpus * $PRECO_PERF_VCPU_MES" | bc -l)
  else
    extra=$(echo "($ram - 256 * $cpus) / 1024" | bc -l)
    (( $(echo "$extra < 0" | bc -l) )) && extra=0
    vm=$(echo "$cpus * $PRECO_SHARED_X_MES + $extra * $PRECO_RAM_EXTRA_GB_MES" | bc -l)
  fi

  volgb=$(flyctl volumes list -a "$app" --json 2>/dev/null | jq '[.[].size_gb] | add // 0')
  vol=$(echo "$volgb * $PRECO_VOLUME_GB_MES" | bc -l)
  nips=$(flyctl ips list -a "$app" --json 2>/dev/null | jq '[.[] | select(.Type=="v4")] | length')
  ip=$(echo "$nips * $PRECO_IPV4_MES" | bc -l)

  # egress dos últimos 7d projetado para o mês (7d aguenta o fim de semana parado sem distorcer)
  egb=$(prom "sum(increase(fly_edge_data_out{app=\"$app\"}[7d]))/1e9")
  eg=$(echo "$egb / 7 * 30 * $PRECO_EGRESS_GB" | bc -l)

  total=$(echo "$vm + $eg + $vol + $ip" | bc -l)
  cams=$(conta_cameras "$app")

  if [ -n "$cams" ]; then
    porcam=$(printf '%.2f' "$(echo "$total / $cams" | bc -l)")
    camtxt="$cams"
  else
    porcam="nao-medido"; camtxt="?"
  fi

  printf '%-14s %8s %9.2f %9.2f %9.2f %9.2f %10.2f %12s\n' \
    "$app" "$camtxt" "$vm" "$eg" "$vol" "$ip" "$total" "$porcam"

  if [ "$kind" = "performance" ] && [ -n "$cams" ]; then
    uso=$(prom "sum(rate(fly_instance_cpu{app=\"$app\",mode!=\"idle\"}[6h]))/100")
    cap=$(echo "if ($uso > 0) $cpus / $uso * $cams else 0" | bc -l)
    printf '   └─ CPU %.2f de %s vCPU · cabem ~%.0f câmeras neste tamanho · marginal US$%.2f/câmera\n' \
      "$uso" "$cpus" "$cap" "$(echo "if ($cap > 0) $vm / $cap else 0" | bc -l)"
  fi
done
