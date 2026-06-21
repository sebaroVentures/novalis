# Git-Sync-Engine für Novalis — Entscheidungsdokument

Stand: 2026-06-12. Evidenzbasis: 3 Live-Web-Research-Pakete (zitiert als **[R-gix]**, **[R-git2]**, **[R-PA]** für Prior Art/Shell-out) und 2 heute ausgeführte Hands-on-Prototypen gegen die aktuellen Releases (**[P-gix]** = gix 0.84.0, **[P-git2]** = git2 0.21.0 / libgit2 1.9.4).

---

## 1. Empfehlung

**git2 0.21.0 (libgit2-Bindings) als alleinige Engine für den gesamten Sync-Zyklus.**

Begründung in einem Satz: git2 ist die einzige der drei Optionen, die den kompletten Zyklus auto-commit → fetch → merge → conflict-materialization → resolve → push **heute mit lauffähigem Code bewiesen** abdeckt (gesamte Prototyp-Matrix bestanden), während gix auf Protokoll-Ebene nicht pushen kann und Shell-out auf iOS eine Sackgasse und auf Desktop eine Bundling-Bürde ist.

**Konfidenz: hoch** für den Desktop-Scope (macOS jetzt, Windows/Linux als Nächstes). **Mittel** für den Mobile-Pfad — machbar (Working-Copy-Präzedenz), aber C-Deps-Cross-Compile ist unverifiziertes Build-Engineering, siehe Abschnitt 4.

Sekundär-Empfehlung: einen opt-in „use system git for network ops"-Escape-Hatch (jj/cargo-Muster **[R-PA]**) als Setting vorsehen, aber nicht als Primärpfad bauen.

---

## 2. Entscheidungsmatrix

| Anforderung | gix 0.84.0 | git2 0.21.0 | Shell-out (git binary) |
|---|---|---|---|
| **Push (HTTPS + ssh)** | ❌ **Nicht implementiert, Protokoll-Ebene**: kein send-pack in gix-protocol 0.59, kein `prepare_push()`, auch kein HTTPS-Push-Pfad; Tracking-Issue #306 offen, Maintainer empfiehlt Selbstbau **[R-gix, P-gix]** | ✅ Bewiesen gegen lokales bare remote inkl. Merge-Commit-Push; Live-Remote (GitHub/GitLab) im Spike **nicht** exerziert **[P-git2]** | ✅ Vollständig (git selbst), sofern Binary vorhanden/gebündelt **[R-PA]** |
| **Auth headless (PAT + ssh-agent/key)** | HTTPS: ja, `Connection::with_credentials`-Closure. SSH: nur via gespawntem externem `ssh`-Binary, keine native agent-Integration **[R-gix]** — wegen fehlendem Push für die Schreibhälfte ohnehin irrelevant **[P-gix]** | ✅ `RemoteCallbacks::credentials` mit `Cred::userpass_plaintext` / `ssh_key_from_agent` / `ssh_key` / `ssh_key_from_memory`; kompiliert und verdrahtet, keine Terminal-Prompts in der API; `auth-git2` crate für Ergonomie **[P-git2, R-git2, R-PA]** | ✅ `GIT_TERMINAL_PROMPT=0` + `GIT_ASKPASS`/credential helper — bewährtes dugite/jj-Muster **[R-PA]** |
| **Merge + Konflikt-Materialisierung** | ✅ Stark: `merge_commits` erkennt Konflikte, Stage-1/2/3-Entries, beide Seiten als Blobs, Marker-Rendering — aber kein MERGE_HEAD-Persist, kein abort/continue, Worktree-Checkout des Merge-Ergebnisses DIY **[P-gix, R-gix]** | ✅ **Vollständig end-to-end bewiesen**: `merge_analysis`, in-memory `merge_commits` (Detection ohne Workdir-Touch), `index.conflicts()` mit ancestor/our/their, alle drei Seiten als Blobs materialisiert, resolve via `add_path` + 2-Parent-Commit + `cleanup_state()` **[P-git2]** | ✅ git kann alles — aber Zugriff für die App nur über CLI-Output-Parsing (`status --porcelain`, `show :N:path`); fragiler Integrationspfad (Einschätzung, kein Paket-Beleg) |
| **.gitignore respektiert** | ✅ dirwalk skippt ignored per Default; `.novalis/` nie emittiert **[P-gix]** | ✅ `add_all` honoriert ignore ohne Flags; `status_should_ignore` bestätigt **[P-git2]** | ✅ nativ |
| **Build-/Bundle-Komplexität** | Beste: pure Rust, **0 \*-sys/cc-Crates**, 138 Crates, 7,9 s clean build **[P-gix]** | Mittel: C-Toolchain nötig, 63 Crates, ~28 s clean build vendored; `vendored-openssl`+`vendored-libgit2` für Distribution **Pflicht** (non-vendored linkt Homebrew-dylibs, per `otool` bewiesen) **[P-git2]** | Schlechteste: macOS `/usr/bin/git` = CLT-Install-Dialog-Falle; Windows hat kein git → MinGit ~34 MB bündeln; Update-Pflege des Binaries **[R-PA]** |
| **Mobile-Pfad (iOS/Android)** | Pure Rust ideal, **aber**: fetch-only (kein Push), und file://+ssh spawnen externe Prozesse — auf iOS nur in-process HTTPS (reqwest+rustls) nutzbar **[P-gix, R-gix]** | Machbar mit C-Build-Engineering: libgit2 treibt Working Copy auf iOS; Android braucht cross-compiled OpenSSL für HTTPS, OpenSSL-Cross-Builds sind dokumentierter Schmerz **[R-PA, R-git2]** | ❌ **Sackgasse auf iOS**: kein Shell-Environment + GPL/App-Store-Problem (Working-Copy-Rationale) **[R-PA]** |
| **MSRV 1.85 / Lizenz** | rust-version = 1.85 exakt, MIT OR Apache-2.0; sitzt aber AN der MSRV-Grenze **[R-gix]** | Keine deklarierte rust-version (rolling „stable N-1"); **Stock-Lockfile bricht auf 1.85** (icu 2.2 via `cred`→url→idna), fixbar via `rust-version`-Deklaration + MSRV-aware resolver — im Spike bewiesen **[P-git2]**. Lizenz sauber: Bindings MIT/Apache, libgit2 GPLv2 **mit Linking-Exception** **[R-git2]** | git ist GPLv2; separater Prozess = mere aggregation, auf Desktop okay mit Lizenztext + Source-Verfügbarkeit **[R-PA]** |
| **Reife / Maintenance** | 0.x mit 47 Breaking-Releases, monatliche API-Brüche, Review-Kapazität des Maintainers „the new bottleneck"; 12+ RUSTSECs, aber schnelle, systematische Security-Response **[R-gix]** | rust-lang-Org, Commits diese Woche; Security-Fixes same-day gebunden (libgit2 1.9.2 → libgit2-sys am selben Tag); kommender Churn: libgit2 v2.0 **[R-git2]** | git selbst maximal reif; Wartungslast liegt beim Bundling (Versions-Updates, Pfad-Bruch-Bugs à la QOwnNotes) **[R-PA]** |

**Lesart:** gix gewinnt Build & Mobile-Reinheit, verliert aber die Schreibhälfte des Zyklus — und Push ist nicht verhandelbar. Shell-out gewinnt nichts, was git2 nicht auch kann, und verliert iOS komplett. git2 ist in keiner Zeile disqualifiziert.

---

## 3. Wo Research und Prototyp sich widersprechen

Der Prototyp (heute ausgeführter Code) schlägt Trainingswissen und Sekundärquellen. Vier Punkte, klar benannt:

1. **gix-Merge-Fähigkeit — [R-PA] lag falsch.** Das Prior-Art-Paket behauptet, gix habe „nur blob-level three-way merge plumbing". **[P-gix]** hat `Repository::merge_commits` mit Tree-Level-Konflikterkennung, Stage-Entries und Both-Sides-Blobs tatsächlich ausgeführt. Der Prototyp gewinnt: gix-Merge ist deutlich besser als das Paket sagt. **Ändert das Verdikt nicht** — der Disqualifier ist Push, und dort sind alle Quellen einig (doppelt bestätigt: Research via crate-status.md/#306, Prototyp via grep über die vendored Sources: null Treffer für send-pack).
2. **git2-MSRV — [R-git2] war zu optimistisch.** Research: „kompatibel mit dem 1.93-Pin heute". **[P-git2]**: Stock-Lockfile schlägt auf rustc 1.85.0 fehl (`icu_collections@2.2.0 requires rustc 1.86`). Der Prototyp gewinnt: MSRV 1.85 hält **nur** mit `rust-version = "1.85"` im Manifest und MSRV-aware Resolver bzw. gepinntem icu 2.1.x. Das ist eine konkrete Workspace-Pflicht, kein Nice-to-have.
3. **gix-Fetch-Transport — [R-gix] (training-knowledge) zu grob.** „Fetch über HTTPS und ssh implementiert und battle-tested" stimmt, aber **[P-gix]** präzisiert: file:// und ssh spawnen externe Prozesse **auch beim Fetch**; nur HTTP(S) via curl/reqwest läuft in-process. Für Desktop egal, für iOS load-bearing.
4. **macOS-OpenSSL — kein Widerspruch, aber Statuswechsel.** [R-git2] hatte die libssh2→OpenSSL-Kette aus build.rs abgeleitet; **[P-git2]** hat sie per `otool -L` am Binary bewiesen und die Konsequenz verschärft: ohne `vendored-openssl` ist das Artefakt nicht auslieferbar (Homebrew-dylib-Abhängigkeit). Jetzt verified statt inferred.

Nur im Prototyp gefunden (Research blind): der bare-repo-Footgun — `Repository::init_bare` ohne `initial_head("main")` erzeugt unborn `master`-HEAD, Push von `refs/heads/main` schlägt dann mit „src refspec does not match" fehl. Relevant für Self-hosted-Remotes und Test-Fixtures **[P-git2]**.

---

## 4. Risiken der Empfehlung + Mitigations

| # | Risiko | Mitigation |
|---|---|---|
| 1 | **Live-Netzwerk-Auth unverifiziert.** Beide Prototypen liefen nur gegen file://-Remotes; der Credential-Callback wurde nie real aufgerufen **[P-git2]**. Das ist die einzige load-bearing Lücke der Evidenz. | **Das entscheidende Experiment, vor P2:** 1-Tages-Spike gegen echtes GitHub + GitLab über HTTPS-PAT und gegen einen ssh-Remote via ssh-agent + Key-File; Redirects und Fehlerpfade (revoked token, falscher Key) mit abdecken. |
| 2 | **Mobile = C-Deps-Cross-Compile** (libgit2 + libssh2 + vendored OpenSSL); dokumentiert schmerzhaft, im Spike nicht getestet **[R-git2, R-PA, P-git2]**. | (a) Working Copy beweist Machbarkeit auf iOS **[R-PA]**; (b) Mobile-v1 auf HTTPS-only scopen — ohne `ssh`-Feature braucht iOS gar kein OpenSSL (SecureTransport) **[R-git2]**; (c) Cross-Compile-CI-Spike vor dem Mobile-Meilenstein einplanen; (d) gix-Push-Status (Issue #306) dann neu evaluieren — die lokale gix-Merge-Qualität **[P-gix]** macht einen späteren Hybrid/Umstieg realistisch. |
| 3 | **MSRV-Drift**: git2-Policy ist rolling N-1, kann 1.85 irgendwann überholen **[R-git2]**; plus der icu-Bruch aus Punkt 3.2. | `rust-version = "1.85"` im Workspace deklarieren, Lockfile committen, CI-Job auf 1.85 als Gate. Akzeptieren, dass ein späterer git2-Bump einen MSRV-Bump erzwingen kann (Maintainer-Frage 6). |
| 4 | **libgit2 v2.0-Churn** kommt (SHA-256, WinHTTP-Deprecation, libssh2-Embedded-Build entfernt) **[R-git2]**. | Auf der 1.9.x-Linie pinnen; v2.0-Migration als eigenes Ticket budgetieren, kein Zeitdruck (1.9.x wird gepflegt, 1.8.5-Security-Backport als Beleg). |
| 5 | `Repository` ist Send aber **!Sync** **[R-git2]**. | Ein Handle, ein dedizierter Sync-Task im Tauri-Backend; kein geteilter Zugriff. Passt zur ohnehin sequentiellen Sync-Schleife. |
| 6 | Security-Historie von libgit2/OpenSSL (CVE-2024-24577 etc.) **[R-git2]**. | `cargo audit`/RUSTSEC in CI; Same-Day-Bump-Policy — git2-rs selbst hat das vorgelebt (1.9.2-Binding am Tag des libgit2-Releases). |
| 7 | **Delete-vs-Edit-Konflikte**: `IndexConflict`-Seiten sind `Option` — unbehandelt panict die App **[P-git2]**. | In der Konflikt-Mapping-Schicht von Tag 1 an alle drei Seiten als optional modellieren; Testfall „Datei hier editiert, dort gelöscht" in die P3-Testmatrix. |
| 8 | `vendored-openssl` braucht perl+make zur Buildzeit (v. a. Linux) **[R-git2]**. | CI-Image entsprechend ausstatten; einmalige Setup-Kosten. |

---

## 5. Konsequenzen für die Phasen P1–P3

Die Evidenz legt einen leicht angepassten Schnitt nahe: **Merge-Mechanik gehört in P2** (ohne sie ist der Pull-Teil des Zyklus unvollständig — genau der Fehler, der Logseqs Git-Sync gekillt hat **[R-PA]**); P3 ist dann reine UI-Verdrahtung.

**P1 — Local auto-commit (sofort startbar, minimale Deps):**
`git2` mit `default-features = false` und **null** Netzwerk-Features — das sind nur 14 Crates und 8,2 s Build **[P-git2]**, kein OpenSSL, kein libssh2. Alles Nötige ist bewiesen: `add_all` mit ignore-Respekt, explizite `Signature` (App-Identität statt globaler gitconfig), Commit, `status_should_ignore` für `.novalis/`/Trash. Debounce/Intervall-Orchestrierung liegt in der App.

**P2 — Remote sync:**
Features auf `["https", "ssh", "vendored-openssl", "vendored-libgit2"]` heben (Achtung: 0.21.0-Default ist leer — vergessen = Local-only-Client, der erst zur Laufzeit scheitert **[P-git2]**). **Zuerst** den Live-Auth-Spike aus Risiko 1. Dann: `fetch` → `merge_analysis` → fast-forward oder `merge` → push; `cleanup_state()` nach Merge-Commit nicht vergessen; bare-HEAD-Footgun nur für Self-hosted/Fixtures relevant. Vorschlag Unterteilung: **P2a** Happy-Path (ff-only; bei Konflikt: Sync stoppen + User benachrichtigen, niemals force-push), **P2b** echter Merge mit Auto-Resolve nicht-konfligierender Dateien.

**P3 — Conflict-UI-Integration:**
Mapping ist 1:1 und end-to-end im Prototyp gelaufen **[P-git2]**: in-memory `merge_commits` zur Detection **ohne Workdir-Touch** → `index.conflicts()` liefert Pfade für `listConflicts` → ancestor/our/their-Blobs liefern beide vollen Seiten für `conflictDiff` → `add_path` + 2-Parent-Commit + `cleanup_state()` ist die `resolveConflict`-Aktion. Verlust einer Seite ist konstruktionsbedingt ausgeschlossen (alle drei Seiten bleiben OID-adressierbar).

---

## 6. Offene Fragen — nur vom Maintainer entscheidbar

1. **SSH im v1-Scope oder HTTPS-PAT-only zuerst?** Ohne `ssh`-Feature entfällt OpenSSL auf macOS/Windows komplett (SecureTransport/WinHTTP) **[R-git2]** — kleinerer Build, weniger Risiko, und PAT deckt GitHub/GitLab ab. SSH später nachrüstbar.
2. **System-git-Escape-Hatch anbieten?** Opt-in-Setting „use system git for network ops" für exotische Auth-Setups (Cargo/jj-Präzedenz **[R-PA]**) — Nutzen vs. zweiter Codepfad, der getestet werden muss.
3. **Merge oder Rebase als Sync-Strategie?** Merge ist vollständig bewiesen; die libgit2-Rebase-API existiert, blieb im Spike aber unverifiziert **[P-git2]**. Empfehlung: Merge. Rebase nur, wenn lineare Historie dem Maintainer wichtig ist — dann braucht es einen eigenen Spike.
4. **Konflikt-UX-Default:** Bei Konflikt blockieren bis der User entscheidet, oder Marker-Datei committen und weiter syncen? Beides technisch möglich; reine Produktentscheidung.
5. **Token-/Key-Storage:** OS-Keychain (macOS Keychain, Windows Credential Manager) vs. App-Config — Sicherheits-/UX-Abwägung außerhalb der Engine-Frage.
6. **MSRV-Politik:** Darf ein künftiges git2-Release einen Workspace-MSRV-Bump über 1.85 erzwingen, oder ist 1.85 hart? (Bestimmt, wie aggressiv git2-Updates eingespielt werden.)
7. **Mobile-Timeline:** Sie bestimmt, wann der Cross-Compile-Spike (Risiko 2) und die gix-Push-Re-Evaluierung terminiert werden — bei „Mobile in <12 Monaten" beides sofort einplanen.

---

*Evidenz-Vollständigkeit: Die einzige unverifizierte load-bearing Frage ist Live-HTTPS/SSH-Auth (Risiko 1, Experiment definiert). Alles andere — Push-Lücke in gix, kompletter git2-Zyklus, Konflikt-Materialisierung, MSRV-Verhalten, Build-Artefakt-Linking — ist durch heute ausgeführten Code belegt.*

---

## Nachtrag (2026-06-12): Live-Auth-Spike — Risiko 1 GESCHLOSSEN

Maintainer-Sign-off erfolgt (git2, HTTPS-PAT-first, Merge, block-on-conflict, OS-Keychain); P1
(`feat/git-sync` `328ad9a`) gelandet. Danach das in Risiko 1 definierte Experiment live gegen
GitHub ausgeführt (git2 0.21, Features `https`+`vendored-openssl`+`vendored-libgit2` — das exakte
P2-Set; OAuth-Token aus `gh auth token`, nie geloggt; Testobjekt: temporärer Branch
`git2-auth-spike-tmp` am öffentlichen Repo aus bereits publizierten Objekten, danach gelöscht
und per API-404 verifiziert):

| Test | Ergebnis |
|---|---|
| In-process HTTPS-Clone | ✅ 0,9 s, kein Credential-Callback nötig (public) |
| **Authentifizierter Push** (Branch-Create) | ✅ 1,4 s, `Cred::userpass_plaintext("x-access-token", <token>)`, Callback exakt 1× — **die load-bearing Frage** |
| Authentifiziertes ls-remote (`connect_auth` + `list`) | ✅ Branch remote sichtbar |
| Branch-Delete-Push (`:refs/heads/…`) | ✅ 1,0 s |
| **Falscher Token** | ✅ sauberer Fehler in 0,5 s, kein Prompt, kein Hängen — **aber**: libgit2 ruft den Credential-Callback bei 401 WIEDERHOLT auf (4×, bis unser Zähler abbrach). **P2-Pflicht: Attempt-Bound im Callback**, sonst Endlosschleife bei revoked Token. |

**Offen bleibt (ehrlich):** GitLab/self-hosted ungetestet (keine Test-Credentials verfügbar) —
GitHub-Pfad ist verifiziert, der Transport ist generisch; GitLab beim ersten P2-Manualtest
mitprüfen. SSH bleibt per Sign-off auf später verschoben.

**P2 ist damit entsperrt.** Konkreter erster Schritt: Feature-Flags im Workspace heben,
RemoteCallbacks-Wrapper mit Attempt-Bound als Erstes bauen.