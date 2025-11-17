# Vencord Theme Controller Plugin

This repository contains the **Theme Controller** Vencord plugin which adds a
fully featured theme management UI with manual selection, randomization and
scheduling support.

## Files

- `ThemeControllerPlugin.ts` – the plugin source code.

## Usage & Setup

1. Copy `ThemeControllerPlugin.ts` into your Vencord `plugins/` directory.
2. Rebuild or reload Vencord so it registers the new plugin.
3. Enable the plugin from the Vencord settings page and configure:
   - **General** section for manual theme selection and the master toggle.
   - **Randomization** section to pick the random pool, frequency, and behavior.
   - **Scheduling** section to define day/time-based rules that override other
     modes when active.
4. Changes are applied immediately; scheduling has the highest priority followed
   by randomization and manual selection.
