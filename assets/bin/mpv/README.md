Place bundled mpv binaries in this directory so the app can run standalone without a user-side mpv install.

Supported lookup order in runtime:

- assets/bin/mpv/<platform>-<arch>/mpv(.exe)
- assets/bin/mpv/<platform>/<arch>/mpv(.exe)
- assets/bin/mpv/<platform>/mpv(.exe)
- assets/bin/mpv/mpv(.exe)
- assets/bin/mpv/<platform>-<arch>/mpv.app/Contents/MacOS/mpv
- assets/bin/mpv/<platform>/mpv.app/Contents/MacOS/mpv

Examples:

- assets/bin/mpv/darwin-arm64/mpv
- assets/bin/mpv/darwin-x64/mpv
- assets/bin/mpv/win32-x64/mpv.exe
- assets/bin/mpv/linux-x64/mpv
