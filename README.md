# WebSpace Manager

**File, terminale SSH, database MySQL e stato del server di tutti i tuoi spazi web, nella sidebar di VS Code.**
Credenziali sempre cifrate con una superpassword. Nessuna connessione parte se non sei tu a chiederla.

![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.85-007ACC?logo=visualstudiocode&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-supportato-0078D6?logo=windows&logoColor=white)
![Ubuntu](https://img.shields.io/badge/Ubuntu-supportato-E95420?logo=ubuntu&logoColor=white)
![Protocolli](https://img.shields.io/badge/SFTP%20%C2%B7%20FTP(S)%20%C2%B7%20SSH%20%C2%B7%20MySQL-informational)

![Panoramica di WebSpace Manager](docs/media/overview.gif)

---

## Indice
- [Cosa fa](#cosa-fa)
- [Installazione](#installazione)
- [Primi passi](#primi-passi)
- [Funzioni nel dettaglio](#funzioni-nel-dettaglio)
- [Scorciatoie da tastiera](#scorciatoie-da-tastiera)
- [Impostazioni](#impostazioni)
- [Sicurezza](#sicurezza)
- [Domande frequenti](#domande-frequenti)
- [Sviluppo](#sviluppo)

---

## Cosa fa

Uno **spazio** è un sito o un server: raccoglie in un solo nodo della sidebar tutto quello che serve per lavorarci.

| | |
|---|---|
| **File** | SFTP, FTP o FTPS, con una root path che non si può oltrepassare. Apri, modifica e salva direttamente sul server. |
| **Terminale SSH** | Un terminale integrato in VS Code, anche già posizionato nella cartella su cui hai cliccato. |
| **MySQL** | Una o più connessioni per spazio, dirette o tramite tunnel SSH. Esplora database e tabelle, scrivi query, modifica struttura, esporta i dati. |
| **Telemetria** | CPU, RAM, load, uptime, dischi e quota, processi principali, stato di MySQL. |
| **Cartelle** | Raggruppa gli spazi per cliente o progetto, fissa in cima i preferiti, filtra e cerca. |
| **Vault** | Password, chiavi private e passphrase cifrate con AES-256-GCM. Export/import cifrato, anche per un collega. |

Funziona su **Windows e Ubuntu** senza installare nulla sul sistema: niente client SSH, FTP o MySQL esterni.

---

## Installazione

### Da file `.vsix` (consigliato)
1. Scarica l'ultimo `webspace-manager-x.y.z.vsix` dalla pagina [Releases](https://github.com/Bellonio/vscode-plugin-ftpsshmysql/releases).
2. In VS Code apri il pannello Estensioni (`Ctrl+Shift+X`), menu **`...`** in alto, **Installa da VSIX...** e scegli il file.

   Oppure da terminale:
   ```
   code --install-extension webspace-manager-0.1.0.vsix
   ```
3. Nella barra delle attività a sinistra compare l'icona di **WebSpace Manager**.

![Installazione da VSIX](docs/media/install.gif)

### Dai sorgenti
```
git clone https://github.com/Bellonio/vscode-plugin-ftpsshmysql.git
cd vscode-plugin-ftpsshmysql
npm install
npm run package        # crea webspace-manager-x.y.z.vsix
```
Poi installa il `.vsix` come sopra.

> Se VS Code risponde "please restart VS Code before reinstalling", chiudi **tutte** le finestre di VS Code, riaprilo e ripeti l'installazione.

---

## Primi passi

1. **Crea la superpassword.** Al primo spazio che aggiungi ti viene chiesta: serve a cifrare tutte le credenziali. Non viene salvata da nessuna parte.
2. **Aggiungi uno spazio** con il pulsante **+** nella barra della vista. Il form ha due blocchi affiancati:
   - **Server**: host, porta, utente, protocollo (SFTP/FTP/FTPS), root path, password o chiave privata.
   - **Database**: una o più connessioni MySQL, ognuna diretta o tramite SSH.

   ![Form di uno spazio](docs/media/space-form.png)
3. **Connettiti** espandendo **File** o **DB**. Solo in quel momento viene chiesta la superpassword.
4. **Lavora**: apri file, salva con `Ctrl+S`, apri il terminale o la telemetria dal menu contestuale dello spazio.
5. **Disconnetti** dal menu dello spazio quando hai finito. Dopo 8 ore senza attività in VS Code tutti gli spazi si disconnettono da soli.

---

## Funzioni nel dettaglio

### Sidebar e organizzazione
- **Un click non connette mai.** Selezionare uno spazio o una cartella non apre connessioni: ci si collega solo espandendo "File"/"DB" o aprendo terminale e telemetria.
- **Cartelle**: assegna una cartella a uno spazio dal form. Le cartelle si rinominano o si rimuovono dal menu contestuale (gli spazi tornano alla radice).
- **Ordinamento**: il pulsante nella barra alterna **A-Z** e **manuale**. In manuale si spostano gli spazi con `Alt+↑`/`Alt+↓` o con "Sposta in cima/in fondo". **Fissa in cima** funziona in entrambe le modalità.
- **Filtra** (icona imbuto): mostra solo gli spazi di un server, di un tipo (SFTP, FTP, MySQL...) o di una cartella. Il filtro attivo compare accanto al titolo della vista.
- **Cerca** (`Ctrl+Alt+F`): trova cartelle, spazi e file **già caricati** nell'albero. Non interroga mai il server.

![Cartelle, filtro e ricerca](docs/media/sidebar.gif)

### File remoti
- **Apri e salva** direttamente sul server.
- Dal menu contestuale:
  - nuovo file o cartella;
  - rinomina (`F2`) ed elimina (`Canc`, con conferma);
  - carica file o cartelle, scarica;
  - copia il path remoto;
  - apri un terminale SSH già in quella cartella.
- **Upload drag & drop**: trascina file o cartelle da Esplora risorse (o dall'Explorer di VS Code) su una cartella remota. I nodi remoti non sono trascinabili, così non sposti mai una cartella per sbaglio.
- **Protezione dalle sovrascritture**: se il file è cambiato sul server dopo che l'hai aperto, al salvataggio ti viene chiesto se sovrascrivere. Se lo hai aperto senza modifiche e cambia online, compare un avviso **Ricarica**.
- **Schede ripristinate offline**: alla riapertura di VS Code i file remoti restano aperti e modificabili **senza connettersi**. La connessione parte solo quando salvi.
- **Versioni precedenti**: ogni lettura dal server salva una copia locale (file sotto 1 MB, al massimo 50 versioni per file). L'icona orologio sul file apre la cartella delle versioni.
- **FTPS con certificato self-signed**: l'opzione "Accetta certificato non valido" nel form.

![Modifica e salvataggio di un file remoto](docs/media/files.gif)

### Terminale SSH
- **Apri terminale SSH** dal menu dello spazio, oppure **Apri terminale qui** su una cartella.
- Terminale, telemetria e tunnel MySQL usano **una sola connessione SSH** per spazio.

### MySQL
- Esplora connessioni, database, tabelle, colonne e indici.
- **Nuova query SQL** apre un editor SQL: `Ctrl+Enter` esegue. Il database di destinazione si sceglie dalla barra dell'editor.
- **Apri dati** di una tabella, **Mostra CREATE TABLE**.
- **Esporta** un database o una tabella in **SQL, CSV o JSON**.
- Struttura:
  - crea o elimina database e tabelle;
  - aggiungi, modifica ed elimina colonne e indici;
  - rinomina o svuota una tabella.

  Le operazioni distruttive chiedono sempre conferma.
- **Tunnel SSH**: per i database raggiungibili solo dal server, spunta "via SSH" nella connessione.

![Query MySQL](docs/media/mysql.gif)

### Telemetria
- CPU, RAM, load average, uptime, dischi e quota, processi principali, stato di MySQL.
- Pensata per **non farti bannare**:
  - esegue un solo comando di rilevamento;
  - se il server non permette di eseguire comandi (account solo SFTP, shell limitata) lo dice subito e non ci riprova;
  - ogni campionamento è un solo comando sulla connessione SSH già aperta, e gira solo con il pannello visibile;
  - al primo errore si ferma finché non premi "Riprova rilevamento".

![Telemetria del server](docs/media/telemetry.png)

### Export e import
Dal menu **`...`** della vista:
- **Esporta spazi**: crea un file `.wsm.json` con le credenziali **cifrate**.
  - **Backup personale** (altro PC, reinstallazione): si importa con la tua superpassword.
  - **Per un collega**: scegli una password di consegna diversa e quali segreti togliere. Il collega li inserisce all'import.
- **Importa spazi**: le credenziali vengono ricifrate con la superpassword locale.

---

## Scorciatoie da tastiera

| Tasti | Azione | Dove |
|---|---|---|
| `Ctrl+Alt+F` (`Cmd+Alt+F` su macOS) | Cerca spazi, cartelle e file caricati | Ovunque |
| `F2` | Rinomina file o cartella remota | Sidebar |
| `Canc` | Elimina file o cartella remota (con conferma) | Sidebar |
| `Alt+↑` / `Alt+↓` | Sposta lo spazio su/giù | Sidebar, ordinamento manuale, senza filtro |
| `Ctrl+Enter` (`Cmd+Enter`) | Esegui la query | Editor SQL |
| `Ctrl+S` | Salva il file sul server | Editor di un file remoto |

Le scorciatoie si possono cambiare da **File > Preferenze > Scelte rapide da tastiera** cercando `wsm.`.

---

## Impostazioni

| Impostazione | Default | Descrizione |
|---|---|---|
| `wsm.sortMode` | `alpha` | Ordinamento degli spazi: `alpha` (A-Z) o `manual`. |
| `wsm.telemetry.interval` | `10` | Secondi tra un campionamento e l'altro della telemetria (minimo 5). |

---

## Sicurezza

- **Niente in chiaro.** Password, chiavi private e passphrase sono cifrate con **AES-256-GCM**; la chiave deriva dalla superpassword tramite **scrypt**.
- **Superpassword mai memorizzata.** Viene chiesta a ogni connessione di uno spazio. Le credenziali decifrate restano solo in memoria finché lo spazio è connesso: **Disconnetti** le cancella.
- **Nessun ban.** Una superpassword sbagliata viene riconosciuta in locale, prima di contattare il server. Gli accessi falliti sul server non vengono mai ritentati in automatico.
- **Chiavi host SSH verificate** (trust on first use, fingerprint SHA256). Se la chiave del server cambia, compare un avviso bloccante.
- **Chiave privata dentro lo spazio**, cifrata: l'export funziona anche su un altro PC o sistema operativo.

> **Se dimentichi la superpassword le credenziali non sono recuperabili.**
> Con **Reset vault** (menu `...`) cancelli tutte le credenziali ma tieni gli spazi, poi le reinserisci.
> Per cambiarla usa **Cambia superpassword**.

---

## Domande frequenti

**Perché mi chiede la superpassword ogni volta?**
È voluto: non viene mai salvata, nemmeno in memoria tra una connessione e l'altra. Una volta connesso, lo spazio resta sbloccato fino alla disconnessione (o a 8 ore di inattività).

**Ho aperto VS Code e i file remoti sono ancora nelle schede: si è connesso da solo?**
No. Le schede mostrano una copia locale; la connessione parte solo se salvi o se espandi "File".

**La telemetria dice che il server non permette comandi.**
L'account è solo SFTP o ha una shell limitata. File e MySQL funzionano lo stesso.

**L'installazione del `.vsix` fallisce.**
Chiudi tutte le finestre di VS Code e riprova. Se avevi già una versione installata, disinstallala prima.

---

## Sviluppo

```
npm install
npm run build        # bundle in dist/ (F5 avvia l'Extension Development Host)
npm run watch        # rebuild automatico
npm run typecheck    # controllo dei tipi
npm test             # unit test: vault, ordinamento, parser telemetria, generatore SQL
npm run package      # typecheck + build + .vsix
```

Dipendenze di runtime solo JavaScript (`ssh2`, `basic-ftp`, `mysql2`): lo stesso `.vsix` funziona su Windows e Linux.
