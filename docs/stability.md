# Efficienza e stabilità

## Revisione del 21 novembre 2026

- **Finestre:** il passaggio Progetti/workspace attende un frame disegnato prima
  del resize. Le richieste sono serializzate e le transizioni superate vengono
  cancellate; il vincolo minimo viene applicato dopo la dimensione finale per
  evitare un'espansione intermedia. Dimensioni salvate e minime rispettano
  l'area utile del monitor e il suo fattore di scala.
- **Tema nativo:** finestra e WebView usano lo stesso sfondo dell'interfaccia.
  La sincronizzazione termina prima di mostrare o ridimensionare la finestra.
- **Salvataggi:** chiusura di schede e finestra attendono le scritture pendenti.
  Errori e nuove modifiche durante il salvataggio conservano il buffer aperto;
  il cambio progetto viene fermato se restano modifiche da salvare.
- **Ripristino Git:** nomi come `[a].txt` sono trattati come percorsi letterali,
  senza coinvolgere `a.txt`. Il ripristino funziona anche aprendo un workspace
  da una sottocartella del repository. L'autosave viene sospeso e le scritture
  pendenti completate prima del ripristino, poi riprendono per i buffer residui.
- **Diff:** il comando apre il confronto anche senza una modifica già rilevata
  dallo stato Git, mostrando l'esito del confronto effettivo.
- **Verifiche UI:** aggiornati i test alle conferme personalizzate e alle
  scorciatoie correnti; conteggi per file e attese del rendering evitano
  interferenze fra autosalvataggi e controlli su altre operazioni.

Verifiche: **157 test JavaScript**, **134 test Rust**, **82 controlli UI**,
build TypeScript/Vite e build desktop con frontend incorporato. Il lint termina
senza errori; restano avvisi React e di analisi statica preesistenti.

La prova nativa Windows usa un profilo e una cartella temporanei separati:
760×500 → 1280×800 → 760×500, nei temi scuro e chiaro, con un solo evento di
ridimensionamento per passaggio. Verificato anche il salvataggio delle ultime
battute chiudendo immediatamente la finestra. Il monitor reale era a scala 1,
con area utile 1920×1032; monitor piccoli e HiDPI sono coperti dai test simulati.

Resta utile separare la gestione di documenti e operazioni workspace da
`App.tsx`, mantenendo le regressioni sulla concorrenza, e limitare la raccolta
dei risultati di ricerca per nome nelle directory molto grandi preservando
l'ordinamento dei risultati.

## Verifica del 17 novembre 2026

Questa passata riguarda concorrenza, code e risorse. Le verifiche riproducono
raffiche di eventi, risposte obsolete, chiusura dei server e processi figli che
mantengono aperte le pipe; non stimano una percentuale di accelerazione globale.

| Area | Problema individuato | Correzione verificata |
| --- | --- | --- |
| Git | Refresh da focus, timer e filesystem potevano sovrapporsi; risultati identici invalidavano i pannelli | Una richiesta attiva e un solo aggiornamento pendente per workspace; stato React conservato quando identico |
| File aperti | Letture concorrenti potevano applicare un vecchio contenuto dopo un salvataggio o un reload più recente | Richieste serializzate e aggregate per percorso; risposte superate scartate; guardia su revisione e contenuto salvato |
| Cambio progetto | Eventi del vecchio watcher potevano ricaricare percorsi omonimi del progetto nuovo | Payload del watcher associato al workspace e filtro nel frontend; code eliminate alla chiusura o al cambio progetto |
| Terminali | Ogni sessione registrava due listener globali, filtrando anche tutti gli eventi delle altre sessioni | Due listener condivisi e dispatch per ID; cleanup su errore e fine sessione; input pendente eliminato dopo exit |
| Watcher | Canale illimitato con un evento allocato per scrittura, anche nelle directory generate | Esclusione preventiva delle directory generate, insieme di percorsi unici e coda di risveglio con capacità uno; arresto del worker su drop |
| Explorer | La creazione esterna di una cartella vuota veniva esclusa dagli eventi | Eventi di directory conservati, senza letture dei metadati per scartarli |
| LSP | Header non limitati prima dell'allocazione; race fra registrazione di una richiesta e chiusura del server | Header limitati a 16 KiB; registrazione e controllo del server sotto lo stesso mutex |
| Comandi acquisiti dall'agente | stdout/stderr potevano crescere senza limite; il join dei lettori poteva attendere un processo figlio indefinitamente | Buffer limitati, gestione del timeout dell'albero di processi e letture delle pipe cancellabili su Windows |
| Build & Run | Uno script terminato poteva restare segnato in esecuzione e occupare uno slot mentre un figlio distaccato teneva aperte le pipe | Lettori interrompibili e svuotamento finale limitato; evento di fine e rilascio dello slot anche con pipe ereditate |

## Evidenze

- Nel test delle code, 100 nuovi trigger durante una lettura producono soltanto
  una richiesta attiva e una successiva. Il risultato intermedio non arriva
  all'editor. La stessa proprietà viene verificata nell'interfaccia Chrome.
- 100 sessioni terminale condividono un listener nativo per tipo di evento:
  due listener complessivi, anziché 200. Il callback viene cercato direttamente
  per ID. Test aggiuntivi coprono registrazioni concorrenti, retry e callback
  tardivi di connessioni già dismesse.
- Il test watcher inserisce 30.000 eventi duplicati o generati e conserva un
  solo percorso valido da elaborare, senza accodare gli eventi originali.
- La race LSP viene riprodotta con un mutex controllato, senza dipendere da
  ritardi arbitrari. Una richiesta avviata mentre il server termina riceve
  subito il fallimento, senza rimanere pendente fino al timeout.
- Il parser LSP verifica il limite esatto dell'header, header eccessivi,
  duplicati, incompleti, UTF-8 non valido e messaggi concatenati.
- Un comando che produce oltre 1 MiB conserva inizio, fine e diagnostica stderr
  entro il limite configurato. Una fixture con processo figlio di 60 secondi
  verifica che la cattura termini senza aspettarne la chiusura delle pipe.

## Comportamento dell'output acquisito

Per i comandi acquisiti tramite il tool dell'agente vengono conservati fino a
**256 KiB per stream**: metà iniziale e metà finale. Il troncamento viene
segnalato nel testo. Dopo la conclusione della shell, lo svuotamento delle pipe
ha un massimo di un secondo; se un discendente le mantiene aperte, viene
indicata l'interruzione della lettura. La gestione del timeout tenta di fermare
l'albero del processo avviato.

Il limite di 256 KiB riguarda la cattura dei comandi del tool agente, non lo
scrollback dei terminali interattivi né il trasporto streaming di Build & Run.
Anche Build & Run interrompe la lettura, con una nota esplicita, quando un figlio
distaccato mantiene le pipe aperte dopo la conclusione del processo principale.
La lettura cancellabile delle pipe è implementata per Windows, piattaforma
supportata dall'app.

## Riproduzione

Esito finale: **103 test JavaScript**, **104 test Rust** e **70 scenari UI**
superati; build TypeScript/Vite riuscita. Nessuna eccezione browser o comando
desktop non riconosciuto nello smoke test. I test includono anche il
salvataggio di un file invariato mentre una lettura precedente è ancora in volo.
Compilato con successo anche l'eseguibile Windows release con frontend
incorporato: `release/helmcode-optimized.exe`.

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --offline
npm run test:ui
```

Lo smoke test usa Chrome con trasporto desktop simulato. I test Rust avviano
anche Git, PowerShell e il language server TypeScript reali.
