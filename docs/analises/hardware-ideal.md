# Hardware ideal para o hub — levantamento (jul/2026)

> Dimensionamento ancorado nas **medições do projeto** (eval/MODELS.md, perf-input-size-dfine,
> spike-dfine §3/§6/§7, homolog DO 4-core) + pesquisa de mercado 06/07/2026 (US$1=R$5,17).
> Workflow de 2 agentes; divergência entre eles RECONCILIADA aqui (ver §1 — a matemática
> física venceu o orçamento grosso).

## Resposta executiva

| Cenário | CPU | RAM | Disco | GPU | Custo aprox. |
|---|---|---|---|---|---|
| **Piloto 5-8 câmeras** | **Ryzen 9 7900/9900X (12c)** — ou 7700 (8c) p/ 5-6 câm | 32GB (ECC se ASRock Rack) | NVMe 1TB | **Nenhuma** | **R$ 7-9k** (build AM5) |
| **CD médio 15-25 câmeras** | **24-32 cores** OU **16c (7950X/9950X) + INT8/VNNI validado** OU **2 hubs de 12-16c** | 64GB ECC | 2× NVMe 1TB (espelho) | Nenhuma | **R$ 8-12k/hub** |
| **Grande 40-60 câmeras** | **2-3 hubs de 24-32c** (shard por câmeras — preferível a um box de 64-80c) | 16GB+/hub | NVMe/hub | Nenhuma | 2-3× o cenário médio |
| **Nunca comprar** | Xeon E-2400 / Core 12ª-14ª gen / Core Ultra (SEM AVX-512) · GPU (hoje) | — | — | — | — |

**Critério nº1 de compra: CPU com AVX-512 VNNI** (AMD Zen 4/5 = Ryzen 7000/9000, EPYC 4004/4005;
Xeon Scalable Ice Lake+). É o multiplicador de **2-3× via INT8** — e sem VNNI o INT8 mediu **7× PIOR**.
Condicional honesto: o 2-3× é literatura/extrapolação — exige spike de paridade + eval full-set
antes de virar default (mas a CPU certa custa O MESMO, então compre com VNNI de qualquer forma).

## 1. A matemática (com a CORREÇÃO crítica)

**⚠ O "7 câmeras/core" do autoscale é orçamento por HUB-DE-8-CORES, não por core.** A capacidade
física medida (CPU-time real, process.cpuUsage, harness de produção):

| Tier | CPU medido/frame | câmeras/core @1fps (pico) | num 8-core |
|---|---|---|---|
| N | 0,45 core·s | 2,2 | ~17 |
| **S (default)** | **1,07 core·s** | **0,93** | **~7** |
| M | 1,88 core·s | 0,53 | ~4 |

**Regra de bolso: 1 câmera S @1fps no PICO ≈ 1 core.** Fórmula:
```
cores ≈ câmeras_S × 1,0  +  câmeras_N × 0,45  +  câmeras_longRange × 4,6
      + câmeras_RTSP × 0,05-0,15 (ffmpeg ingest)
      + 1-2 (hub + go2rtc + SO + PG local)
      + ~1 por câmera FOCADA (boost 6fps satura 1 worker)
```
- **Gate de movimento**: a MÉDIA é muito menor que o pico (20-45 pulos/min medidos; noite ≈ 0
  inferência) — mas vigilância se dimensiona pelo PICO. A economia vira energia/térmica, não
  hardware menor. Corolário: nada de instância cloud burstable.
- **Tier misto** corta custo: câmera sem contagem crítica em N = 0,45 core (metade), ao custo
  de recall (F1 37 vs 74).
- **Autoscale = rede de segurança, não plano**: hardware apertado não derruba (degrada S→N);
  o sizing acima garante **qualidade S sustentada no pico**.

## 2. RAM, disco, rede (todos coadjuvantes)

- **RAM**: ~200-240MB × worker (workers = min(cores/2, câmeras)) + hub ~0,5-1GB + ffmpeg
  ~50MB/câm + PG 0,5-1GB + SO. Piloto: **8-16GB** · médio: **16-64GB** · por hub grande: 16GB+.
- **Disco**: app+modelos ~1,2GB; histórico é **SÓ metadado** (LGPD — nenhuma imagem):
  P ≤80MB, M ≤240MB, G ≤600MB @30 dias de retenção. **NVMe 1TB sobra em qualquer cenário**
  (2× em espelho onde o PG for local e importante). Disco nunca é o gargalo.
- **Rede**: ingest RTSP 2-4Mbps/câmera (30-240Mbps no total) + WebRTC de saída aos operadores.
  **1GbE resolve até ~25 câmeras; 2×1GbE/2.5GbE no grande.** Switch PoE das câmeras à parte.

## 3. GPU — NÃO comprar (por medição, não opinião)

DML retornou **saída errada** e WebGPU **crashou** nesta família DETR (medido, spike §5);
CUDA EP não vem no onnxruntime-node (build própria = spike). GPU hoje = R$ 2-15k + energia +
risco de paridade sem ganho validado. **O que mudaria a conta**: modelo maior/VLM no futuro,
fps denso (>10fps) em dezenas de câmeras, ou um spike CUDA/TensorRT com paridade verde.
A plataforma AM5 recomendada mantém PCIe 5.0 x16 livre — a porta fica aberta sem pagar por ela.

## 4. O mapa VNNI (a armadilha de compra)

**TEM AVX-512 VNNI**: AMD Zen 4/5 (Ryzen 7000/9000, EPYC 4004/4005/8004/9004/9005) · Xeon
Scalable Cascade Lake+ (Ice Lake, Sapphire/Emerald Rapids). *(O i7-11390H do dev tem — por
isso o INT8 rendeu na literatura citada lá.)*

**NÃO TEM (fora da rota)**: TODO desktop Intel desde a 12ª gen (AVX-512 fundido no silício) —
inclusive o **Xeon E-2400** dos servidores de entrada **Dell T160/R260, Lenovo ST250/SR250,
HPE ML30** (só AVX2-VNNI, não medido pela casa). Ou seja: o ecossistema clássico de "servidor
de entrada de marca" está FORA; as rotas reais no BR são build/integrador **AM5** (ASRock Rack
B650D4U com IPMI+ECC), **Lenovo ThinkSystem ST45 V3** (EPYC 4004/4005 — a única torre de marca
com a ISA certa) ou Supermicro AS-x015A via integrador.

## 5. Preços de referência (BR, 06/07/2026 — voláteis)

Ryzen 7 7700 ~R$1,5-1,6k · Ryzen 9 7900 R$2,35-2,53k · 9900X ~R$2,4-2,7k · 7950X ~R$2,7-3,4k ·
EPYC 4344P US$329/4464P US$429 (BR sob cotação) · ST45 V3 ref. EU €1.177 (BR ~R$9-14k estimado) ·
Dell T160 (NÃO comprar p/ isto) R$11-16k · Dell R660xs (Silver 4410Y) R$21k+ (sem vantagem).

## 6. Cloud × on-prem — on-prem vence em produção

- DO CPU-Optimized 8vCPU/16GB = ~R$870/mês = **R$10,4k/ano** → o hardware on-prem **se paga
  em <1 ano**, e vCPU compartilhada ≠ core dedicado (S degradou 385→400-520ms no droplet).
- **O argumento decisivo é o ingest**: 30-240Mbps de upload 24/7 do CD pra nuvem = dependência
  do link + ponto de falha fora do prédio. Com o hub na LAN, o tráfego morre no rack — e o
  **LGPD/local-first** (invariante do projeto) alinha: frames efêmeros nunca saem do prédio.
- Nuvem continua perfeita pro papel atual: **homolog/demo**.

## Riscos residuais declarados
INT8 2-3× é condicional (spike de paridade + eval antes de ligar); preços EPYC/ST45 no BR são
sob cotação; o boost de foco a 6fps é latência-limitado a ~2-2,5fps reais no S (o custo é ~1
core, não 6×); volume de eventos/dia do PG é estimativa de schema (medir no piloto).
