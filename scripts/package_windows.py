#!/usr/bin/env python3
"""Build the portable Windows app from the verified official Electron runtime."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import shutil
import stat
import struct
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "44.7.0"
ASSET = f"electron-v{VERSION}-win32-x64.zip"
BASE = f"https://github.com/electron/electron/releases/download/v{VERSION}"
CACHE = ROOT / ".cache" / "electron"
DIST = ROOT / "dist"
APP = DIST / "Toca-e-Trilha-Windows-x64"


def fetch(url, target):
    request = urllib.request.Request(url, headers={"User-Agent": "Toca-e-Trilha-build"})
    with urllib.request.urlopen(request, timeout=60) as response, target.open("wb") as output:
        copied = 0
        reported = 0
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            copied += len(chunk)
            if copied - reported >= 32 * 1024 * 1024:
                print(f"Electron: {copied // (1024 * 1024)} MiB baixados", flush=True)
                reported = copied


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()


def main():
    if not (ROOT / "node_modules" / "ws" / "package.json").exists():
        raise SystemExit("Execute npm ci antes de empacotar.")
    CACHE.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)
    checksums = CACHE / f"SHASUMS256-v{VERSION}.txt"
    if not checksums.exists():
        fetch(BASE + "/SHASUMS256.txt", checksums)
    expected = next((line.split()[0] for line in checksums.read_text().splitlines()
                     if line.split()[-1].lstrip("*") == ASSET), None)
    if not expected:
        raise SystemExit("Checksum do runtime Windows ausente no release oficial.")
    runtime = CACHE / ASSET
    if not runtime.exists():
        temporary = runtime.with_suffix(".download")
        fetch(BASE + "/" + ASSET, temporary)
        if digest(temporary) != expected:
            temporary.unlink()
            raise SystemExit("SHA-256 do Electron não confere; runtime rejeitado.")
        temporary.rename(runtime)
    if digest(runtime) != expected:
        raise SystemExit("SHA-256 do runtime em cache não confere; não será usado.")
    print("SHA-256 do runtime Windows verificado:", expected, flush=True)
    if APP.exists():
        shutil.rmtree(APP)
    APP.mkdir()
    with zipfile.ZipFile(runtime) as archive:
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if path.is_absolute() or ".." in path.parts or "\\" in item.filename or stat.S_ISLNK(item.external_attr >> 16):
                raise SystemExit("Entrada insegura no arquivo do runtime.")
        archive.extractall(APP)
    (APP / "electron.exe").rename(APP / "Toca-e-Trilha.exe")
    default = APP / "resources" / "default_app.asar"
    if default.exists():
        default.unlink()
    app_root = APP / "resources" / "app"
    app_root.mkdir(parents=True)
    for filename in ["package.json", "package-lock.json", "server.js"]:
        shutil.copy2(ROOT / filename, app_root / filename)
    for directory in ["desktop", "public"]:
        shutil.copytree(ROOT / directory, app_root / directory)
    shutil.copytree(ROOT / "node_modules" / "ws", app_root / "node_modules" / "ws")
    readme = """TOCA & TRILHA — protótipo 0.1.0

1. Extraia TODO este ZIP para uma pasta do seu computador.
2. Abra Toca-e-Trilha.exe. Não precisa instalar Node.js, npm ou Adobe AIR.
3. Escolha seu nome e clique em Entrar na trilha.

Objetivo: pegue o queijo e volte à toca.
Movimento: A/D ou setas. Salto: Espaço/W/seta para cima. Reinício: R.
Para testar multiplayer no mesmo computador, pressione Ctrl+N e use
o mesmo nome de sala nas duas janelas. Cada janela é um jogador.
Fechar todas as janelas encerra o servidor local.

Este pacote inicia um servidor próprio em 127.0.0.1, com uma porta livre,
e funciona sem acessar servidores do Transformice. Não inclui contas,
mapas, código ou arte do Transformice. É um protótipo original de uma fase.
O menu Jogo fica acessível com Alt. Windows 10/11, processador x64.

Runtime Electron e suas licenças estão incluídos nesta pasta.
"""
    (APP / "LEIA-ME.txt").write_text(readme, encoding="utf-8")
    info = {
        "game": "Toca & Trilha", "version": "0.1.0", "platform": "win32-x64",
        "electron": VERSION, "runtime_source": BASE + "/" + ASSET,
        "runtime_sha256": expected,
        "entrypoint": "Toca-e-Trilha.exe",
        "gameplay_assets": "original procedural Canvas artwork",
    }
    (APP / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    exe = (APP / "Toca-e-Trilha.exe").read_bytes()
    if exe[:2] != b"MZ":
        raise SystemExit("Executável Windows sem cabeçalho PE.")
    pe_offset = struct.unpack_from("<I", exe, 0x3C)[0]
    if exe[pe_offset:pe_offset + 4] != b"PE\x00\x00" or struct.unpack_from("<H", exe, pe_offset + 4)[0] != 0x8664:
        raise SystemExit("Runtime não é um executável PE Windows x64.")
    game_zip = DIST / "Toca-e-Trilha-Windows-x64.zip"
    with zipfile.ZipFile(game_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in sorted(APP.rglob("*")):
            if path.is_file():
                output.write(path, Path(APP.name) / path.relative_to(APP))
    source_zip = DIST / "Toca-e-Trilha-codigo-fonte.zip"
    with zipfile.ZipFile(source_zip, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(ROOT.rglob("*")):
            relative = path.relative_to(ROOT)
            if any(part in {".git", "node_modules", "dist", ".cache", "__pycache__"} for part in relative.parts):
                continue
            if path.suffix == ".pyc":
                continue
            if path.is_file():
                output.write(path, Path("Toca-e-Trilha") / relative)
    print("Pacote Windows:", game_zip, game_zip.stat().st_size, "bytes", flush=True)
    print("Código-fonte:", source_zip, source_zip.stat().st_size, "bytes", flush=True)
    print("SHA-256 do pacote:", digest(game_zip), flush=True)


if __name__ == "__main__":
    main()
