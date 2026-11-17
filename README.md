# helmcode

Uno spazio desktop essenziale per sviluppare con AI, codice e Git. L'interfaccia usa superfici scure neutre, un accento salvia e un unico layout coerente tra le modalità AGENT e HELM.

Realizzato per Windows con Tauri v2, React, CodeMirror 6 e xterm.js.

Repository: [github.com/francescoflora/helmcode](https://github.com/francescoflora/helmcode)

In **Impostazioni → Aspetto** puoi scegliere **Scuro**, **Chiaro** o **Sistema**.
La preferenza viene ricordata e applicata anche a editor, diff, terminali e menu;
cambiarla conserva le sessioni e il contenuto dei file. **Sistema** segue anche
i cambiamenti di tema di Windows. Le [note di design](docs/design.md) descrivono
palette, icone e tipografia.

## Requisiti

- Windows 10/11 con WebView2, presente di default su Windows 11
- Node.js 20+
- Rust con toolchain MSVC
- Git per branch, stato del repository e differenze
- `opencode`, `pi`, `claude` o `agy` nel PATH per la modalità AGENT, in base all'agente scelto nelle impostazioni

## Avvio in sviluppo

```powershell
npm install
npm run start
```

`npm run start`, equivalente a `npm run tauri:dev`, avvia Vite e la finestra desktop di helmcode. Mantieni aperto il processo durante lo sviluppo.

L'eseguibile `src-tauri/target/debug/helmcode.exe` richiede il frontend di sviluppo su `http://localhost:1420`; per usare l'app senza Vite crea una build standalone.

## Schermata progetti

All'avvio helmcode mostra una finestra compatta con:

- apertura di una cartella esistente
- creazione di una cartella vuota come nuovo progetto
- elenco dei progetti recenti, con rimozione singola

All'avvio normale compare la splash screen, seguita da un passaggio diretto senza dissolvenza o sfocatura. L'opzione “Mostra la splash screen” resta disponibile nelle impostazioni. Il comando “Nuova finestra” del menu apre direttamente la schermata Progetti senza splash e senza modificare la preferenza per gli avvii normali.

Il pulsante con il nome del progetto nella title bar apre il selettore cartelle e carica il progetto scelto nella finestra corrente. La freccia accanto apre il menu progetto: nuovo progetto vuoto, nuova finestra, progetti recenti e “Tutti i progetti”. Per nuovi progetti e recenti viene chiesto se aprirli nella finestra corrente o in una nuova: ogni nuova finestra è un'istanza separata con progetto, terminali e LSP indipendenti, mentre recenti e preferenze restano condivisi. “Nuova finestra” parte dalla schermata Progetti. Le preferenze di avvio, modalità iniziale, agente CLI e aggiornamenti sono in `Impostazioni`.

## Build standalone

```powershell
npm run build:app
```

Output:

- `src-tauri/target/release/helmcode.exe`: eseguibile standalone con frontend incorporato
- `src-tauri/target/release/bundle/nsis/helmcode_<versione>_x64-setup.exe`: installer Windows

Al primo avvio scegli o crea un progetto dalla schermata iniziale.

## Versione

`package.json` è l'unica fonte del numero di versione. `tauri.conf.json` legge `"version": "../package.json"` e Vite inietta la versione nel frontend.

```powershell
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
```

`--no-git-tag-version` aggiorna `package.json` e `package-lock.json` senza creare commit o tag. Lo script `version` esegue `scripts/sync-version.mjs`, che allinea automaticamente `src-tauri/Cargo.toml` e la voce della crate in `src-tauri/Cargo.lock`.

Per verificare che i file siano allineati senza modificarli:

```powershell
npm run check-version
```

La CI esegue lo stesso controllo e fallisce se le versioni divergono.

## Aggiornamenti automatici

helmcode controlla gli aggiornamenti all'avvio e li propone nel menu Aggiornamenti. Dopo il download l'app salva le modifiche se richiesto e si riavvia.

Puoi controllare manualmente dal menu Aggiornamenti o dalle impostazioni.

## Modalità AGENT

- L'agente CLI scelto nelle impostazioni (`opencode` predefinito, `pi`, Claude Code o `agy`) si avvia nel workspace corrente; la modifica vale dal prossimo avvio di AGENT.
- L'area AGENT occupa lo spazio disponibile senza riquadri, intestazione del terminale o elenco laterale delle sessioni.
- La sessione rimane attiva passando a HELM, così puoi controllare file e modifiche mentre l'agente lavora.
- Rendering WebGL con ripiego automatico sul renderer DOM se il contesto grafico viene perso.

## Modalità HELM

- Explorer per cartelle e file, ricerca nel workspace, Git e Build & Run.
- Pulsanti Nuovo file e Nuova cartella e menu con clic destro in Explorer: la creazione avviene nella cartella selezionata, nella cartella del file selezionato o nella radice quando si clicca su un'area vuota. Conferma con Invio, annulla con Esc; i file esistenti sono preservati.
- Trascina file o cartelle in Explorer per spostarli: la destinazione si evidenzia e le cartelle chiuse si aprono dopo una breve sosta. Rilascia nell'area vuota per tornare alla radice. Lo spostamento usa lo stesso refactoring di Rinomina, aggiornando schede aperte e riferimenti tramite i language server disponibili; eventuali limitazioni vengono segnalate.
- Editor CodeMirror con `Ctrl+S` per salvare il file attuale.
- Nell'editor `Tab` indenta la riga o la selezione e `Shift+Tab` riduce l'indentazione, mantenendo il focus nel codice.
- Icone e colori per tipo di file e cartella, condivisi fra Explorer, schede, ricerca e Git. I colori delle modifiche Git restano separati dalle icone.
- Evidenziazione della sintassi per i linguaggi del catalogo CodeMirror: HTML con CSS/JavaScript incorporati, JS/TS e React, CSS/SCSS, Python, Rust, JSON/JSONC, YAML, TOML, Markdown e altri. I parser vengono caricati quando apri un file; i formati non riconosciuti restano modificabili come testo semplice.
- Ricaricamento automatico dei file modificati da processi esterni quando la scheda non contiene modifiche non salvate.
- Sidebar ridimensionabile e pannello terminali sotto l'editor, apribile dall'icona Terminali nella barra sinistra.
- Le scorciatoie `Ctrl+Shift+E/F/G/B` mostrano la sezione File, Cerca, Git o Build; premute di nuovo mentre la sezione è visibile la nascondono.
- Terminali PowerShell indipendenti nella cartella di progetto: creazione senza un limite fisso di schede, selezione, rinomina, chiusura e riavvio delle sessioni terminate. Nascondere il pannello o passare ad AGENT conserva le sessioni; cambiare progetto le chiude.
- `Ctrl+Shift+T` mostra o nasconde i terminali e, all'apertura, dà il focus alla sessione attiva. `Ctrl+Backquote` mostra o nasconde il pannello; `Ctrl+Shift+Backquote` crea un terminale nuovo. Il separatore superiore permette di ridimensionare il pannello con trascinamento o frecce su/giù.
- Confronto del file attuale con la versione Git, accessibile anche dalla lista delle modifiche.
- Il selettore HELM e l'icona Git mostrano il numero di file modificati, includendo le modifiche non ancora salvate senza contare due volte lo stesso file.

## Autocompletamento e navigazione del codice

I suggerimenti si aprono mentre scrivi o con `Ctrl+Spazio`. Usa le frecce per scegliere e `Invio` per inserire; `Esc` chiude l'elenco. Negli snippet `Tab` e `Shift+Tab` passano fra i campi; fuori dagli snippet continuano a indentare il codice.

- `Ctrl+clic`: navigazione contestuale. Su un utilizzo apre la definizione; sulla dichiarazione o sulla firma di un metodo, oggetto o classe cerca le implementazioni. Se non trova implementazioni, cerca una dichiarazione diversa da quella corrente. Le destinazioni coincidenti con il simbolo cliccato vengono escluse.
- `F12`: vai alla definizione del simbolo, con ripiego sulla dichiarazione quando disponibile.
- `Ctrl+Shift+clic` o `Ctrl+F12`: cerca le implementazioni.
- `Ctrl+Shift+F12`: vai alla dichiarazione.
- Clic destro su un simbolo: scegli una delle tre operazioni. Se il server restituisce più destinazioni, l'editor permette di scegliere quale aprire.

La navigazione e i completamenti semantici usano Language Server Protocol (LSP), compreso il contenuto non ancora salvato. I file delle dipendenze restituiti dal server possono essere aperti in sola lettura; le sorgenti virtuali e gli archivi, per esempio gli URI `jdt:`, richiedono un supporto specifico e non sono ancora apribili. La barra inferiore dell'editor mostra lo stato del collegamento: cliccandola trovi dettagli e il pulsante per riprovare. Senza server restano disponibili i completamenti nativi del parser, le parole del documento e, per i linguaggi principali, parole chiave e snippet locali.

Il server del linguaggio deve essere installato con i suoi runtime ed essere raggiungibile nel `PATH`, oppure configurato con un percorso esplicito. helmcode avvia automaticamente i server disponibili quando apri un file e li chiude cambiando progetto; non installa strumenti globali. Alcune associazioni predefinite:

| Linguaggio | Server / comando |
| --- | --- |
| JavaScript, TypeScript, JSX, TSX | `typescript-language-server --stdio` (preferisce la copia in `node_modules` del progetto) |
| Java | `jdtls` e un JDK compatibile con la versione installata del server; indice separato per progetto nella cartella temporanea |
| Python | `pyright-langserver --stdio` |
| Rust | `rust-analyzer` |
| C, C++, Objective-C | `clangd` |
| C# | `csharp-ls` |
| Go | `gopls serve` |
| PHP | `intelephense --stdio` |
| Ruby | `ruby-lsp` |
| HTML, CSS/SCSS/LESS, JSON/JSONC | `vscode-html-language-server`, `vscode-css-language-server`, `vscode-json-language-server` con `--stdio` |
| YAML | `yaml-language-server --stdio` |
| Vue, Svelte | `vue-language-server --stdio`, `svelteserver --stdio` |
| Lua, Dart, Kotlin | `lua-language-server`, `dart language-server --protocol=lsp`, `kotlin-language-server` |
| Shell, TOML, XML | `bash-language-server start`, `taplo lsp stdio`, `lemminx` |

Sono previste anche associazioni per Zig, Elixir, Erlang, Haskell, OCaml, Perl e R. L'analisi di simboli, dipendenze e implementazioni dipende dalle funzionalità del server e dalla configurazione di build del progetto.

Per aggiungere qualsiasi linguaggio con un server LSP su stdio, o sostituire un'associazione predefinita, crea `.helmcode/languages.json` nella radice del progetto:

```json
{
  "servers": [
    {
      "languageId": "java",
      "extensions": ["java"],
      "command": "C:/tools/jdtls/bin/jdtls.bat",
      "args": ["-data", "${workspaceFolder}/.cache/jdtls"],
      "initializationOptions": {},
      "settings": { "java": { "autobuild": { "enabled": true } } }
    },
    {
      "languageId": "custom",
      "extensions": ["custom"],
      "filenames": ["Specialfile"],
      "command": "${workspaceFolder}/tools/custom-language-server.exe",
      "args": ["--stdio"]
    }
  ]
}
```

`languageId` e `command` sono obbligatori; specifica almeno uno fra `extensions` e `filenames`. Vince la prima associazione personalizzata corrispondente. Gli argomenti sono un array e `${workspaceFolder}` viene espanso in `command` e `args`; le estensioni possono avere il punto iniziale e il confronto ignora maiuscole/minuscole. Le modifiche alla configurazione vengono lette alla successiva richiesta. Il comando avvia un processo locale del progetto.

Per Java: [Eclipse JDT Language Server](https://github.com/eclipse-jdtls/eclipse.jdt.ls). Per il protocollo: [specifica LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/).

## Git

- Visualizzazione del branch attuale e dei branch disponibili.
- Passaggio a un altro branch senza forzare o scartare le modifiche locali.
- Elenco dei file staged, modificati e non tracciati.
- Differenze del file rispetto a Git, incluse le modifiche presenti nell'editor.
- Grafo SVG dei commit di tutti i branch e tag, con messaggio, hash breve, autore e data; la cronologia carica altri commit su richiesta. I riferimenti mostrano icone distinte per branch corrente, branch locale, branch remoto e tag, con il nome completo nel tooltip.
- Tasto destro su un commit nel grafo per eseguire il cherry-pick sul branch corrente.
- Dal menu della freccia del commit: `Esegui merge` (scelta ramo di partenza e destinazione), `Esegui merge da` (destinazione = branch corrente) e `Commit e push`. I rami di origine possono essere locali o remoti; la destinazione solo locale.
- In caso di conflitti si apre un resolver: per ogni blocco si può accettare la versione corrente, quella in arrivo o entrambe, con azioni “tutte correnti/tutte in arrivo”; per i conflitti senza marcatori si sceglie direttamente la versione. L'operazione si completa con “Completa merge”/“Completa cherry-pick” o si annulla con il pulsante corrispondente.
- Nella barra di stato la doppia freccia sincronizza il repository corrente: se ci sono commit sia da scaricare sia da inviare apre un menu con `Pull`, `Push` e `Pull e push`; se una sola direzione ha commit esegue automaticamente il pull o il push; senza commit in attesa esegue `git fetch --all --prune`. Il pull è reale (`fetch` + merge dell'upstream) e gli eventuali conflitti si risolvono dal pannello Git. L'asterisco accanto al branch e sulla sua icona segnala commit da inviare o ricevere rispetto all'upstream; il tooltip mostra i conteggi dopo l'ultimo fetch.
- Il pulsante unico con errori e avvisi apre direttamente Problemi in HELM, anche dalla modalità AGENT o dalla scheda Output.

I badge di HELM e della barra laterale Git contano i file da revisionare nel workspace. Il tooltip della doppia freccia riporta i commit in entrata e in uscita.

## Build & Run

- Rilevamento automatico dei task da `package.json`, `Cargo.toml` e `src-tauri/Cargo.toml`.
- I pulsanti Build e Avvia eseguono il task associato come build e come avvio; l'associazione si imposta cliccando la riga nella lista “Task del progetto”, dove il visto indica i due task predefiniti (icona chiave inglese per build/tool, play per i comandi di avvio). La scelta è salvata per progetto; i task del progetto non eseguono nulla al clic. Salvataggio dei file modificati prima dell'avvio di un task.
- Avvio di build e script nel workspace con visualizzazione dell'output, senza aprire terminali in HELM.
- Sezione con le schede Problemi/Output ridimensionabile trascinando il bordo superiore e comprimibile fino alla sola riga delle schede; riducendola, la lista dei task si espande. I problemi con posizione riconosciuta permettono di aprire il relativo file.
- Output in streaming, interruzione dei processi e cronologia delle ultime esecuzioni.

## Workspace

Senza `DEV_WORKSPACE` l'app parte dalla schermata progetti. Per aprire una cartella specifica all'avvio:

```powershell
$env:DEV_WORKSPACE="C:\percorso\progetto"
npm run start
```

La ricerca mostra due sezioni collassabili: i file corrispondenti per nome o percorso e le occorrenze nei contenuti. Le cartelle generate come `node_modules`, `target`, `dist` e `.git` sono escluse.

## Verifica e icone

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:ui
```

I benchmark riproducibili sono `npm run bench:diff` e `npm run bench:backend`.
Il [rapporto sulle prestazioni](docs/performance.md) descrive interventi, misure e limiti delle verifiche.
Il [rapporto su efficienza e stabilità](docs/stability.md) documenta gestione delle risorse, concorrenza e test di regressione.

Il logo vettoriale è `app-icon.svg`: il timone Compatto, con otto impugnature arrotondate e mozzo pieno. L'interfaccia usa la stessa geometria nel componente `BrandMark` e nell'icona della modalità HELM; AGENT usa un robot. Per rigenerare le icone delle piattaforme:

```powershell
npm exec tauri icon app-icon.svg
```
