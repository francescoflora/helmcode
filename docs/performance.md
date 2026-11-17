# Verifica e ottimizzazione delle prestazioni

Verifica locale del 16 novembre 2026 su Windows, Node 24.11.1 e Rust/Cargo 1.99.
Baseline dei benchmark backend: `f935f70868db44131541cf9c2fb455ac55532901`.

## Interventi

- **Ricerca:** preparazione della query una sola volta e confronto ASCII senza
  allocazioni per ogni riga. Restano invariati confronto Unicode, colonne,
  anteprime, limiti dei risultati ed esclusione delle dipendenze.
- **Git:** branch, upstream, divergenza e file modificati vengono letti con
  porcelain v2. Un aggiornamento richiede 2 processi anziché 6–7; rimangono
  supportati repository annidati, rename, conflitti e worktree.
- **Explorer e watcher:** chiavi di ordinamento calcolate una sola volta;
  percorsi generati esclusi prima delle letture dei metadati.
- **Confronti:** grandi diff renderizzano solo le righe visibili con un margine;
  lo spazio totale e la larghezza orizzontale restano disponibili. Il parser
  lavora in intervalli di circa 8 ms ed evidenzia soltanto la finestra visibile.
- **LSP:** i server con sincronizzazione incrementale ricevono un singolo edit
  minimo, con posizioni UTF-16 e gestione di Unicode e CRLF/CR/LF. I server che
  richiedono il testo completo continuano a riceverlo.
- **Terminali:** input ordinato e aggregato per sessione, dimensioni duplicate
  scartate e una sola richiesta di ridimensionamento attiva. Serializzazione
  dell'output senza array JSON intermedi; buffer limitato senza riallocazioni
  temporanee durante output continuo.
- **Interfaccia e build:** pannelli memoizzati per evitare rendering durante la
  digitazione; output build concatenato una sola volta per aggiornamento e
  diagnostica condivisa quando si visualizza l'ultima esecuzione.
- **I/O:** letture, salvataggi, creazione di elementi e operazioni PTY spostate
  dal thread UI al pool di lavoro. I salvataggi restano ordinati per file e
  vincolati al progetto originale, anche dopo un cambio di workspace.

Sono stati corretti anche il controllo invertito delle modifiche non salvate
prima di checkout/merge, l'editor nascosto durante il confronto, lo scroll
sincronizzato che ignorava posizioni già visitate e l'asterisco remoto che
compariva per semplici modifiche locali.

## Misure

Microbenchmark del matcher: mediana di 5 esecuzioni su 100.000 righe ripetute,
compilato con `rustc -O`. Sono esclusi accesso al disco e rendering.

| Caso | Prima | Dopo | Rapporto |
| --- | ---: | ---: | ---: |
| ASCII, ignora maiuscole, assente | 1.373,43 ms | 137,73 ms | 9,97× |
| ASCII, ignora maiuscole, presente | 556,29 ms | 45,33 ms | 12,27× |
| ASCII, distingue maiuscole, assente | 371,24 ms | 18,93 ms | 19,61× |
| Unicode, ignora maiuscole | 1.178,66 ms | 651,82 ms | 1,81× |

La sequenza di comandi Git passa da 7 a 2 processi; nel benchmark sotto carico,
mediana di 5 esecuzioni, da 5.883,83 a 1.592,33 ms. Questi tempi dipendono molto
dal carico e dal costo di avvio dei processi Windows.

Su un diff TypeScript di circa 10.000 righe, Chrome monta **51 righe anziché
10.001**, con **683 nodi DOM anziché 130.026**. L'altezza complessiva resta
240.048 px. Una singola misura in sviluppo, comprendente caricamento dei parser,
passa da circa 6,2 a 1,3 secondi; è indicativa e dipende dalla cache.

Nel test LSP su un documento di 340.019 byte, una singola inserzione produce un
payload di **96 byte anziché 420.112 byte**. È una misura del traffico stdio nel
caso verificato, non della latenza complessiva del server.

## Riproduzione

Esito finale: build frontend riuscita, **81 test JavaScript**, **90 test Rust** e
**59 controlli UI** superati. Nessuna eccezione browser o chiamata desktop non
riconosciuta nello smoke test. Il benchmark browser sul diff ha superato anche
i controlli di scorrimento, larghezza stabile, cambio sintassi e salto alla
prima modifica; nell'ultima esecuzione il rendering richiede circa 1,2 secondi.

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --offline
npm run test:ui
npm run bench:diff
npm run bench:backend
```

Il test UI usa Chrome e il trasporto desktop simulato; verifica editor,
salvataggi, Git, build, navigazione LSP, operazioni sui file e ciclo di vita dei
terminali. I test Rust esercitano anche Git, PowerShell e il language server
TypeScript reali. I test di avvio a freddo dei processi hanno un budget di
30 secondi per tollerare il carico delle suite parallele; i timeout applicativi
restano invariati.

I benchmark richiedono Chrome oppure `CHROME_PATH`, Git e rustc. Scrivono artefatti
di verifica sotto `.qa`, esclusa da Git. Le misure non costituiscono una stima
dell'accelerazione dell'intera applicazione e non coprono ogni progetto o server
LSP possibile.

## Eseguibile

È disponibile `release/helmcode-optimized.exe`, compilato in modalità release
con frontend incorporato (`tauri/custom-protocol`). È un eseguibile standalone;
l'installer esistente non viene aggiornato. La build separata permette di provare
le modifiche mantenendo aperta l'istanza precedente.

Per rigenerarlo dalla radice del progetto:

```powershell
npm run build
New-Item -ItemType Directory -Path release -Force | Out-Null
$optimizedExe = Join-Path $PWD 'release/helmcode-optimized.exe'
cargo rustc --manifest-path src-tauri/Cargo.toml --release --offline --features tauri/custom-protocol --bin helmcode -- -o $optimizedExe
```
