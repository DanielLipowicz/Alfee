#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "security-reports");
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "security-reports",
  "scripts",
  "uploads",
  "data",
]);
const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const findings = [];

function timestamp() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function relative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, "/");
}

function addFinding(severity, title, details, fix, filePath) {
  findings.push({
    severity,
    title,
    details,
    fix,
    filePath: filePath ? relative(filePath) : null,
  });
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readUtf8(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (_error) {
    return null;
  }
}

function runNpmAudit(rawAuditFile) {
  const result = spawnSync(NPM_CMD, ["audit", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();
  if (stdout) {
    fs.writeFileSync(rawAuditFile, `${stdout}\n`, "utf8");
  } else {
    fs.writeFileSync(rawAuditFile, "", "utf8");
  }

  if (result.error) {
    addFinding(
      "high",
      "Nie udalo sie uruchomic npm audit",
      `Blad: ${result.error.message}`,
      "Sprawdz czy npm jest zainstalowany i czy uruchamiasz skan w katalogu projektu Node.js."
    );
    return null;
  }

  if (!stdout) {
    if (stderr) {
      addFinding(
        "high",
        "Nie udalo sie uruchomic npm audit",
        `Polecenie nie zwrocilo JSON. Blad: ${stderr.split(/\r?\n/)[0]}`,
        "Napraw instalacje npm i uruchom skan ponownie."
      );
      return null;
    }
    addFinding(
      "medium",
      "npm audit nie zwrocil danych",
      "Polecenie zakonczylo sie bez wyniku JSON.",
      "Sprawdz polaczenie sieciowe i sprobuj ponownie."
    );
    return null;
  }

  try {
    return JSON.parse(stdout);
  } catch (_error) {
    addFinding(
      "medium",
      "Nie mozna sparsowac wyniku npm audit",
      "Wynik polecenia nie byl poprawnym JSON.",
      `Sprawdz surowy plik raportu: ${relative(rawAuditFile)}`
    );
    return null;
  }
}

function extractAuditCounts(audit) {
  if (audit?.metadata?.vulnerabilities) {
    const v = audit.metadata.vulnerabilities;
    return {
      critical: Number(v.critical || 0),
      high: Number(v.high || 0),
      medium: Number(v.moderate || v.medium || 0),
      low: Number(v.low || 0),
      info: Number(v.info || 0),
      total: Number(v.total || 0),
    };
  }

  if (audit?.advisories) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
    for (const advisory of Object.values(audit.advisories)) {
      const severity = String(advisory?.severity || "info").toLowerCase();
      const mapped = severity === "moderate" ? "medium" : severity;
      if (!Object.prototype.hasOwnProperty.call(counts, mapped)) {
        counts.info += 1;
      } else {
        counts[mapped] += 1;
      }
      counts.total += 1;
    }
    return counts;
  }

  return null;
}

function applyPackageChecks(packageJsonPath) {
  const packageRaw = readUtf8(packageJsonPath);
  if (!packageRaw) {
    addFinding(
      "medium",
      "Brak package.json",
      "Nie znaleziono package.json do analizy zaleznosci.",
      "Uruchom skan z katalogu glownego projektu."
    );
    return;
  }

  let pkg = null;
  try {
    pkg = JSON.parse(packageRaw);
  } catch (_error) {
    addFinding(
      "medium",
      "Niepoprawny package.json",
      "Nie udalo sie odczytac zaleznosci.",
      "Napraw format JSON w package.json.",
      packageJsonPath
    );
    return;
  }

  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
  };

  if (!deps.helmet) {
    addFinding(
      "medium",
      "Brak helmet (naglowki security)",
      "Aplikacja Express nie ma biblioteki do automatycznego ustawiania bezpiecznych naglowkow.",
      "Dodaj helmet i skonfiguruj CSP/HSTS odpowiednio do aplikacji.",
      packageJsonPath
    );
  }

  if (!deps["express-rate-limit"]) {
    addFinding(
      "low",
      "Brak globalnego rate limitera",
      "Nie znaleziono express-rate-limit. Ochrona brute-force moze byc niepelna poza logowaniem.",
      "Rozwaz limitowanie ruchu na endpointach publicznych (login, rejestracja, OAuth callback).",
      packageJsonPath
    );
  }

  if (!deps.csurf) {
    addFinding(
      "medium",
      "Brak ochrony CSRF",
      "Nie znaleziono biblioteki csurf ani innego jawnego mechanizmu tokenow CSRF.",
      "Dodaj tokeny CSRF dla formularzy modyfikujacych dane.",
      packageJsonPath
    );
  }
}

function applyCodeChecks() {
  const serverPath = path.join(ROOT, "server.js");
  const uploadPath = path.join(ROOT, "src", "middleware", "upload.js");
  const envExamplePath = path.join(ROOT, ".env.example");

  const server = readUtf8(serverPath) || "";
  const upload = readUtf8(uploadPath) || "";
  const envExample = readUtf8(envExamplePath) || "";

  if (server.includes("SESSION_SECRET || \"dev-session-secret-change-me\"")) {
    addFinding(
      "high",
      "Fallback do slabego SESSION_SECRET",
      "Kod uruchomi sesje nawet z domyslnym sekretem developerskim.",
      "Wymusz ustawienie SESSION_SECRET i przerwij start aplikacji, gdy sekret nie jest skonfigurowany.",
      serverPath
    );
  }

  if (server.includes("app.use(\"/uploads\", express.static(uploadsDir));")) {
    addFinding(
      "medium",
      "Publiczny dostep do uploadow",
      "Wszystkie pliki w uploads sa publicznie serwowane. To zwieksza ryzyko ujawnienia danych.",
      "Rozwaz podpisane URL, ACL per uzytkownik/tenant lub serwowanie przez endpoint z autoryzacja.",
      serverPath
    );
  }

  if (upload.includes("file.mimetype.startsWith(\"image/\")")) {
    addFinding(
      "medium",
      "Walidacja uploadu oparta tylko o MIME",
      "MIME z naglowka moze byc podrobiony. To nie gwarantuje, ze plik jest obrazem.",
      "Sprawdz magic bytes (np. file-type) i rozwaz skaner AV dla uploadow.",
      uploadPath
    );
  }

  if (envExample.includes("FORCE_HTTPS=false")) {
    addFinding(
      "low",
      "FORCE_HTTPS domyslnie wylaczone",
      "Dla deploymentu publicznego mozna przypadkiem zostawic HTTP.",
      "W produkcji ustaw FORCE_HTTPS=true oraz poprawnie skonfiguruj reverse proxy i trust proxy.",
      envExamplePath
    );
  }
}

function collectSourceFiles(dirPath, output = []) {
  if (!fs.existsSync(dirPath)) {
    return output;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      collectSourceFiles(fullPath, output);
      continue;
    }
    if (/\.(js|cjs|mjs|ejs)$/i.test(entry.name)) {
      output.push(fullPath);
    }
  }
  return output;
}

function scanPatternInFiles(files, regex) {
  const matches = [];
  for (const filePath of files) {
    const content = readUtf8(filePath);
    if (!content) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        matches.push({ filePath, line: i + 1, source: lines[i].trim() });
      }
      regex.lastIndex = 0;
    }
  }
  return matches;
}

function applyPatternChecks(files) {
  const riskyChecks = [
    {
      severity: "high",
      title: "Wykryto uzycie eval()",
      regex: /\beval\s*\(/,
      fix: "Usuń eval i zastap bezpieczna logika bez dynamicznej interpretacji kodu.",
    },
    {
      severity: "high",
      title: "Wykryto new Function()",
      regex: /\bnew\s+Function\s*\(/,
      fix: "Unikaj dynamicznej kompilacji kodu. To czesty wektor RCE/XSS.",
    },
    {
      severity: "medium",
      title: "Wykryto child_process.exec/execSync",
      regex: /\bchild_process\.(exec|execSync)\s*\(/,
      fix: "Upewnij sie, ze argumenty nie pochodza od uzytkownika; preferuj spawn z tablica argumentow.",
    },
  ];

  for (const check of riskyChecks) {
    const matches = scanPatternInFiles(files, check.regex);
    if (matches.length === 0) {
      continue;
    }
    const preview = matches
      .slice(0, 5)
      .map((m) => `${relative(m.filePath)}:${m.line} -> ${m.source}`)
      .join(" | ");
    const suffix = matches.length > 5 ? ` (+${matches.length - 5} kolejnych)` : "";
    addFinding(
      check.severity,
      check.title,
      `Wykryto ${matches.length} dopasowan. Przyklady: ${preview}${suffix}`,
      check.fix
    );
  }
}

function sortFindings() {
  findings.sort((a, b) => {
    const left = SEVERITY_ORDER.indexOf(a.severity);
    const right = SEVERITY_ORDER.indexOf(b.severity);
    return left - right;
  });
}

function countBySeverity() {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (!Object.prototype.hasOwnProperty.call(counts, finding.severity)) {
      counts.info += 1;
      continue;
    }
    counts[finding.severity] += 1;
  }
  return counts;
}

function formatFinding(index, finding) {
  const filePart = finding.filePath ? `\n- Plik: \`${finding.filePath}\`` : "";
  return `${index}. [${finding.severity.toUpperCase()}] ${finding.title}
- Szczegoly: ${finding.details}${filePart}
- Rekomendacja: ${finding.fix}
`;
}

function writeMarkdownReport(markdownPath, auditCounts, rawAuditPath, scannedFiles) {
  const findingLines = findings.length
    ? findings.map((f, i) => formatFinding(i + 1, f)).join("\n")
    : "Brak wykrytych problemow przez aktualny zestaw kontrolny.\n";

  const summaryLines = [
    `- Znalezione kontrole statyczne: ${findings.length}`,
    `- Przeskanowane pliki kodu: ${scannedFiles}`,
  ];

  if (auditCounts) {
    summaryLines.unshift(
      `- npm audit: critical=${auditCounts.critical}, high=${auditCounts.high}, medium=${auditCounts.medium}, low=${auditCounts.low}, total=${auditCounts.total}`
    );
  } else {
    summaryLines.unshift("- npm audit: brak poprawnych danych (sprawdz surowy JSON).");
  }

  const content = `# Raport bezpieczenstwa Alfee

Data skanu: ${new Date().toISOString()}
Katalog projektu: ${ROOT.replace(/\\/g, "/")}

## Podsumowanie
${summaryLines.join("\n")}

## Znalezione problemy
${findingLines}

## Artefakty
- Surowy wynik npm audit: \`${relative(rawAuditPath)}\`
- Raport Markdown: \`${relative(markdownPath)}\`
`;

  fs.writeFileSync(markdownPath, content, "utf8");
}

function main() {
  ensureDirectory(REPORT_DIR);
  const stamp = timestamp();
  const auditRawPath = path.join(REPORT_DIR, `npm-audit-${stamp}.json`);
  const reportPath = path.join(REPORT_DIR, `security-scan-${stamp}.md`);

  const audit = runNpmAudit(auditRawPath);
  const auditCounts = extractAuditCounts(audit);
  if (auditCounts) {
    if (auditCounts.critical > 0) {
      addFinding(
        "critical",
        "Wykryto krytyczne podatnosci w zaleznosciach",
        `npm audit raportuje ${auditCounts.critical} krytycznych podatnosci.`,
        "Uruchom `npm audit fix`, a dla pozostalych pozycji wykonaj reczna aktualizacje pakietow."
      );
    }
    if (auditCounts.high > 0) {
      addFinding(
        "high",
        "Wykryto wysokie podatnosci w zaleznosciach",
        `npm audit raportuje ${auditCounts.high} wysokich podatnosci.`,
        "Priorytetowo zaktualizuj podatne biblioteki i zweryfikuj regresje testami."
      );
    }
    if (auditCounts.medium > 0) {
      addFinding(
        "medium",
        "Wykryto srednie podatnosci w zaleznosciach",
        `npm audit raportuje ${auditCounts.medium} srednich podatnosci.`,
        "Zaplanij aktualizacje w najblizszym sprincie i monitoruj nowe CVE."
      );
    }
  }

  applyPackageChecks(path.join(ROOT, "package.json"));
  applyCodeChecks();

  const files = collectSourceFiles(ROOT);
  applyPatternChecks(files);

  sortFindings();
  const counts = countBySeverity();
  writeMarkdownReport(reportPath, auditCounts, auditRawPath, files.length);

  console.log(`Raport zapisany: ${relative(reportPath)}`);
  console.log(`Surowy audit: ${relative(auditRawPath)}`);
  console.log(
    `Podsumowanie findings: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, info=${counts.info}`
  );

  if (counts.critical > 0 || counts.high > 0) {
    process.exitCode = 2;
  }
}

main();
