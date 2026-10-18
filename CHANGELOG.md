# Changelog

## 1.3.0 – 2026-10-19

- Adding a folder (or linking a bin) starts auto-sync right away
- New setting to switch this off: Settings › Import › “Start auto-sync automatically when a folder is added”

## 1.2.0 – 2026-10-18

- New name: **WatchHouse** (formerly Ordnerwache). Settings and project files of the old version are taken over automatically.
- README in English and German with explainer animations, banner and app icon
- Release download `WatchHouse.zip` with a double-click installer for macOS
- The whole panel turns blue while folders are dragged over it
- Fixed: “No project open” after a restart of Premiere Pro (the ExtendScript loader could fail and block all commands)
- Blackletter logo, screenshots in both languages

## 1.1.0 – 2026-10-18

- English and German user interface, switch with the flags at the top of the panel
- Redesigned panel: status card, step-by-step guide, list of watched folders, clickable drop zone
- Help page, column legend and tooltips in the folder manager, settings with explanations
- Confirmation before a watch folder is removed
- Drop zone stays visible in the main view and the folder manager, also when folders are linked
- Works in narrow panels

## 1.0.0 – 2026-10-18

First release.

- Watch folders for Premiere Pro and After Effects with background auto-sync
- Folder structure becomes bin structure, no duplicate imports (path check)
- Waits for files to be fully written, downloads iCloud-only files first
- Image sequence detection and updating of growing sequences
- Camera card detection: Sony a7S, Sony FS/XAVC, AVCHD, Canon XF, Panasonic P2, XDCAM-EX, XDCAM-HD, Sony HDV, RED, ARRIRAW, DCIM
- Per-folder options SUB, REL, SEQ, FLT and color label, inherited by subfolders
- Link existing bins with a suggested folder
- Settings: allowed extensions, ignored folders (with regex), Import Date metadata, PSD/AI import options, notifications
- Finds the real folder when a folder is dropped through a drag shelf app
