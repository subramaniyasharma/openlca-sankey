"""
sankey_gui.py — a Windows desktop front end for generate_sankey.py.

Point it at one or more openLCA contribution-tree exports, set the same options
the command line takes, and it writes a self-contained dashboard per workbook.
Nothing here reimplements the pipeline: every run goes through
``generate_sankey.main()``, so the script stays the single source of truth and
keeps working on its own.

    python sankey_gui.py

Built for the Laboratory for Eco-design, Green Chemistry And Circular
Innovation (LEGACI), Grenfell Campus, Memorial University of Newfoundland —
https://sites.google.com/mun.ca/legaci

Only the standard library is imported here; the Excel and Plotly dependencies
belong to generate_sankey.py and are reported as a missing-dependency message
rather than a traceback if they are absent.
"""

import contextlib
import os
import pathlib
import queue
import sys
import threading
import tkinter as tk
import traceback
import webbrowser
from tkinter import filedialog, messagebox, ttk

APP_DIR = os.path.dirname(os.path.abspath(__file__))
if APP_DIR not in sys.path:                  # so the .bat can launch from anywhere
    sys.path.insert(0, APP_DIR)

ASSET_DIR = os.path.join(APP_DIR, 'gui_assets')

LAB_NAME = 'Laboratory for Eco-design, Green Chemistry And Circular Innovation'
LAB_SHORT = 'LEGACI'
LAB_URL = 'https://sites.google.com/mun.ca/legaci'
CAMPUS = 'Grenfell Campus · Memorial University of Newfoundland'

# --- theme ------------------------------------------------------------------
# Every visual decision lives in this one block on purpose: a design pass only
# has to touch THEME (and drop replacement art into gui_assets/) to reskin the
# whole window.  Colours follow Grenfell Campus's own pages — a white ground,
# near-black body text and the campus blue carrying every accent — and the
# type falls back through the faces actually installed on Windows, since
# Memorial's Avenir is licensed and not redistributable.
THEME = {
    'ink': '#393939',            # Grenfell body text
    'ink_soft': '#6d6d6d',
    'accent': '#1e22aa',         # Grenfell campus blue
    'accent_dark': '#15187a',
    'surface': '#ffffff',
    'surface_alt': '#f4f4f6',
    'band': '#ffffff',
    'rule': '#d8d8dd',
    'field': '#ffffff',
    'log_bg': '#f7f7f9',
    'ok': '#1d6f42',
    'error': '#98002e',          # Memorial claret, kept for failures only

    'font': ('Segoe UI', 10),
    'font_small': ('Segoe UI', 9),
    'font_bold': ('Segoe UI', 10, 'bold'),
    'font_title': ('Segoe UI Semibold', 17),
    'font_sub': ('Segoe UI', 10),
    'font_mono': ('Consolas', 9),

    'pad': 12,
    'gap': 8,
}

# generate_sankey's own defaults, mirrored so the fields open on the same
# numbers the command line would use.
DEFAULTS = {
    'levels': 2,
    'threshold': 2.0,
    'max_depth': 6,
    'max_nodes': 0,
    'payload_min': 0.0,
}


def open_url(url):
    try:
        webbrowser.open(url)
    except Exception:
        pass


def open_file(path):
    """Open a local file in the default browser.

    Via ``as_uri()`` rather than string-building: a Windows path needs
    ``file:///C:/...`` with three slashes and forward separators, and hand-made
    ``file://C:\\...`` is silently ignored by some browsers.
    """
    try:
        open_url(pathlib.Path(os.path.abspath(path)).as_uri())
    except ValueError:
        open_url('file:///' + os.path.abspath(path).replace('\\', '/'))


class _QueueWriter:
    """File-like object that forwards generate_sankey's prints to the log."""

    def __init__(self, put, tag='log'):
        self._put = put
        self._tag = tag
        self._buffer = ''

    def write(self, text):
        self._buffer += text
        while '\n' in self._buffer:
            line, self._buffer = self._buffer.split('\n', 1)
            self._put(('line', line, self._tag))
        return len(text)

    def flush(self):
        if self._buffer:
            self._put(('line', self._buffer, self._tag))
            self._buffer = ''


class SankeyGUI:
    def __init__(self, root):
        self.root = root
        self.events = queue.Queue()
        self.worker = None
        self.paths = []
        self._images = {}          # Tk drops PhotoImages that nothing references

        root.title('openLCA Sankey dashboard — LEGACI')
        root.configure(bg=THEME['surface'])
        root.minsize(760, 640)

        self._scale = float(root.tk.call('tk', 'scaling'))
        self._load_images()
        self._build_style()
        # Order matters: pack hands out space in the order it was asked for, so
        # the header and the credit line are claimed before the body. Squeeze
        # the window and the log shrinks — the footer never gets cut off.
        self._build_header()
        self._build_footer()
        self._build_body()

        root.protocol('WM_DELETE_WINDOW', self._on_close)
        root.after(80, self._drain)

    # --- chrome -------------------------------------------------------------
    def _load_images(self):
        # The header wears the roundel on its own — the wordmark that sits under
        # it in the full logo is unreadable at this size and the lab's name is
        # already set beside it as live text.  Tk does no resampling, so a
        # scaled display needs art that is genuinely larger, not the same file.
        mark = 'legaci-mark-114.png' if self._scale > 1.3 else 'legaci-mark-76.png'
        for key, name in (('logo', mark), ('icon', 'legaci-logo-32.png'),
                          ('campus', 'grenfell-logo.png')):
            path = os.path.join(ASSET_DIR, name)
            if not os.path.exists(path):
                continue           # grenfell-logo.png is optional — see README
            try:
                self._images[key] = tk.PhotoImage(file=path)
            except tk.TclError:
                pass
        if 'icon' in self._images:
            try:
                self.root.iconphoto(True, self._images['icon'])
            except tk.TclError:
                pass

    def _build_style(self):
        style = ttk.Style(self.root)
        # clam is the only bundled theme on Windows that honours background and
        # foreground on buttons and entries; the native theme ignores both.
        with contextlib.suppress(tk.TclError):
            style.theme_use('clam')

        style.configure('.', background=THEME['surface'],
                        foreground=THEME['ink'], font=THEME['font'])
        style.configure('TFrame', background=THEME['surface'])
        style.configure('Band.TFrame', background=THEME['band'])
        style.configure('Rule.TFrame', background=THEME['rule'])
        style.configure('TLabel', background=THEME['surface'],
                        foreground=THEME['ink'])
        style.configure('Band.TLabel', background=THEME['band'],
                        foreground=THEME['ink'])
        style.configure('Title.TLabel', background=THEME['band'],
                        foreground=THEME['ink'], font=THEME['font_title'])
        style.configure('Sub.TLabel', background=THEME['band'],
                        foreground=THEME['ink_soft'], font=THEME['font_sub'])
        style.configure('Hint.TLabel', foreground=THEME['ink_soft'],
                        font=THEME['font_small'])
        style.configure('Section.TLabel', font=THEME['font_bold'],
                        foreground=THEME['accent'])
        style.configure('Link.TLabel', foreground=THEME['accent'],
                        font=THEME['font_small'])

        style.configure('TButton', background=THEME['surface_alt'],
                        foreground=THEME['ink'], borderwidth=1,
                        focusthickness=0, padding=(10, 5))
        style.map('TButton',
                  background=[('active', '#e6e6ea'), ('disabled', '#f0f0f2')],
                  foreground=[('disabled', THEME['ink_soft'])])
        style.configure('Accent.TButton', background=THEME['accent'],
                        foreground='#ffffff', font=THEME['font_bold'],
                        padding=(18, 9))
        style.map('Accent.TButton',
                  background=[('active', THEME['accent_dark']),
                              ('disabled', '#b9bad9')],
                  foreground=[('disabled', '#f0f0f4')])

        style.configure('TCheckbutton', background=THEME['surface'],
                        foreground=THEME['ink'])
        style.map('TCheckbutton', background=[('active', THEME['surface'])])
        style.configure('TEntry', fieldbackground=THEME['field'],
                        bordercolor=THEME['rule'], padding=4)
        style.configure('TSpinbox', fieldbackground=THEME['field'],
                        arrowsize=12, padding=3)
        style.configure('TProgressbar', background=THEME['accent'],
                        troughcolor=THEME['surface_alt'], borderwidth=0)
        style.configure('TLabelframe', background=THEME['surface'],
                        bordercolor=THEME['rule'])
        style.configure('TLabelframe.Label', background=THEME['surface'],
                        foreground=THEME['accent'], font=THEME['font_bold'])

    def _build_header(self):
        band = ttk.Frame(self.root, style='Band.TFrame')
        band.pack(fill='x')

        inner = ttk.Frame(band, style='Band.TFrame')
        inner.pack(fill='x', padx=THEME['pad'], pady=(THEME['gap'], THEME['gap']))

        if 'logo' in self._images:
            ttk.Label(inner, image=self._images['logo'],
                      style='Band.TLabel').pack(side='left', padx=(0, 14))

        text = ttk.Frame(inner, style='Band.TFrame')
        text.pack(side='left', fill='both', expand=True)
        ttk.Label(text, text='openLCA Sankey dashboard',
                  style='Title.TLabel').pack(anchor='w')
        ttk.Label(text, text='Contribution-tree workbook  →  one self-contained '
                             'interactive HTML file',
                  style='Sub.TLabel').pack(anchor='w', pady=(1, 6))
        ttk.Label(text, text=LAB_SHORT + ' · ' + LAB_NAME,
                  style='Sub.TLabel').pack(anchor='w')
        ttk.Label(text, text=CAMPUS, style='Sub.TLabel').pack(anchor='w')

        if 'campus' in self._images:
            ttk.Label(inner, image=self._images['campus'],
                      style='Band.TLabel').pack(side='right', padx=(16, 0))

        ttk.Frame(self.root, style='Rule.TFrame', height=3).pack(fill='x')

    def _build_body(self):
        body = ttk.Frame(self.root)
        body.pack(fill='both', expand=True,
                  padx=THEME['pad'], pady=THEME['pad'])

        self._build_inputs(body)
        self._build_options(body)
        self._build_run(body)

    def _build_inputs(self, parent):
        box = ttk.Labelframe(parent, text=' Contribution-tree workbooks ',
                             padding=THEME['gap'])
        box.pack(fill='both', expand=True)

        row = ttk.Frame(box)
        row.pack(fill='both', expand=True)

        listwrap = ttk.Frame(row)
        listwrap.pack(side='left', fill='both', expand=True)
        self.listbox = tk.Listbox(
            listwrap, height=4, activestyle='none', selectmode='extended',
            bg=THEME['field'], fg=THEME['ink'], font=THEME['font_small'],
            highlightthickness=1, highlightbackground=THEME['rule'],
            highlightcolor=THEME['accent'], selectbackground=THEME['accent'],
            selectforeground='#ffffff', borderwidth=0)
        self.listbox.pack(side='left', fill='both', expand=True)
        bar = ttk.Scrollbar(listwrap, orient='vertical',
                            command=self.listbox.yview)
        bar.pack(side='right', fill='y')
        self.listbox.configure(yscrollcommand=bar.set)

        buttons = ttk.Frame(row)
        buttons.pack(side='left', fill='y', padx=(THEME['gap'], 0))
        for text, command in (('Add files…', self.add_files),
                              ('Scan folder…', self.scan_folder),
                              ('Remove', self.remove_selected),
                              ('Clear', self.clear_files)):
            ttk.Button(buttons, text=text, command=command,
                       width=14).pack(fill='x', pady=2)

        ttk.Label(box, style='Hint.TLabel',
                  text='In openLCA: open a result → Contribution tree → export '
                       'to Excel. Scanning a folder picks up every .xlsx in it '
                       'and below.').pack(anchor='w', pady=(THEME['gap'], 0))

        out = ttk.Frame(box)
        out.pack(fill='x', pady=(THEME['gap'], 0))
        ttk.Label(out, text='Save dashboards to').pack(side='left')
        self.outdir = tk.StringVar(value=os.path.expanduser('~'))
        ttk.Entry(out, textvariable=self.outdir).pack(
            side='left', fill='x', expand=True, padx=THEME['gap'])
        ttk.Button(out, text='Choose…', command=self.choose_outdir,
                   width=14).pack(side='left')
        ttk.Label(box, style='Hint.TLabel',
                  text='Each workbook becomes "<name>-dashboard.html" in that '
                       'folder.').pack(anchor='w', pady=(4, 0))

    def _build_options(self, parent):
        box = ttk.Labelframe(parent, text=' Starting settings ',
                             padding=THEME['gap'])
        box.pack(fill='x', pady=(THEME['pad'], 0))

        grid = ttk.Frame(box)
        grid.pack(fill='x')
        for column in (1, 3, 5):
            grid.columnconfigure(column, weight=1, minsize=90)

        self.levels = tk.StringVar(value=str(DEFAULTS['levels']))
        self.threshold = tk.StringVar(value=str(DEFAULTS['threshold']))
        self.max_depth = tk.StringVar(value=str(DEFAULTS['max_depth']))
        self.max_nodes = tk.StringVar(value=str(DEFAULTS['max_nodes']))
        self.payload_min = tk.StringVar(value=str(DEFAULTS['payload_min']))
        self.title = tk.StringVar(value='')

        fields = (
            ('Levels', self.levels, 0, 0),
            ('Threshold %', self.threshold, 0, 2),
            ('Max depth', self.max_depth, 0, 4),
            ('Max nodes', self.max_nodes, 1, 0),
            ('Payload min %', self.payload_min, 1, 2),
        )
        for label, var, row, column in fields:
            ttk.Label(grid, text=label).grid(
                row=row, column=column, sticky='w', padx=(0, 6), pady=4)
            ttk.Entry(grid, textvariable=var, width=10).grid(
                row=row, column=column + 1, sticky='ew', padx=(0, 18), pady=4)

        ttk.Label(grid, text='Title').grid(row=1, column=4, sticky='w',
                                           padx=(0, 6), pady=4)
        ttk.Entry(grid, textvariable=self.title).grid(
            row=1, column=5, sticky='ew', pady=4)

        ttk.Label(box, style='Hint.TLabel',
                  text='These only set where the dashboard opens — levels, '
                       'threshold, colours and labels all stay adjustable in '
                       'the page itself. Leave the title empty to take it from '
                       'the workbook. 0 means "no cap".').pack(
            anchor='w', pady=(THEME['gap'], THEME['gap']))

        checks = ttk.Frame(box)
        checks.pack(fill='x')
        checks.columnconfigure(0, weight=1)
        checks.columnconfigure(1, weight=1)
        self.pool = tk.BooleanVar(value=False)
        self.balance = tk.BooleanVar(value=False)
        self.cdn = tk.BooleanVar(value=False)
        self.open_when_done = tk.BooleanVar(value=True)
        boxes = (('Pool small flows into "other"', self.pool),
                 ('Plotly from the CDN (smaller file, needs internet)', self.cdn),
                 ('Draw "direct + unresolved"', self.balance),
                 ('Open each dashboard when it is finished', self.open_when_done))
        for index, (text, var) in enumerate(boxes):
            ttk.Checkbutton(checks, text=text, variable=var).grid(
                row=index // 2, column=index % 2, sticky='w', pady=1)

    def _build_run(self, parent):
        box = ttk.Frame(parent)
        box.pack(fill='both', expand=True, pady=(THEME['pad'], 0))

        bar = ttk.Frame(box)
        bar.pack(fill='x')
        self.run_button = ttk.Button(bar, text='Build dashboards',
                                     style='Accent.TButton', command=self.run)
        self.run_button.pack(side='left')
        self.progress = ttk.Progressbar(bar, mode='determinate')
        self.progress.pack(side='left', fill='x', expand=True,
                           padx=(THEME['gap'], THEME['gap']))
        self.status = ttk.Label(bar, text='Ready', style='Hint.TLabel')
        self.status.pack(side='left')

        logwrap = ttk.Frame(box)
        logwrap.pack(fill='both', expand=True, pady=(THEME['gap'], 0))
        # A small floor, not a fixed size: the log expands with the window, and
        # this is only what it shrinks to on a short screen.
        self.log = tk.Text(logwrap, height=4, wrap='word', bg=THEME['log_bg'],
                           fg=THEME['ink'], font=THEME['font_mono'],
                           borderwidth=0, highlightthickness=1,
                           highlightbackground=THEME['rule'],
                           highlightcolor=THEME['rule'], padx=8, pady=6)
        self.log.pack(side='left', fill='both', expand=True)
        logbar = ttk.Scrollbar(logwrap, orient='vertical',
                               command=self.log.yview)
        logbar.pack(side='right', fill='y')
        self.log.configure(yscrollcommand=logbar.set, state='disabled')
        self.log.tag_configure('head', foreground=THEME['accent'],
                               font=('Consolas', 9, 'bold'))
        self.log.tag_configure('ok', foreground=THEME['ok'])
        self.log.tag_configure('error', foreground=THEME['error'])

    def _build_footer(self):
        foot = ttk.Frame(self.root)
        foot.pack(side='bottom', fill='x', padx=THEME['pad'], pady=(6, 10))
        ttk.Frame(self.root, style='Rule.TFrame', height=1).pack(
            side='bottom', fill='x')
        ttk.Label(foot, text=LAB_SHORT + ' · ' + CAMPUS,
                  style='Hint.TLabel').pack(side='left')
        link = ttk.Label(foot, text=LAB_URL, style='Link.TLabel', cursor='hand2')
        link.pack(side='right')
        link.bind('<Button-1>', lambda _e: open_url(LAB_URL))

    # --- file list ----------------------------------------------------------
    def _add_paths(self, paths):
        added = 0
        for path in paths:
            full = os.path.abspath(path)
            if full in self.paths:
                continue
            self.paths.append(full)
            self.listbox.insert('end', full)
            added += 1
        if added and self.outdir.get() == os.path.expanduser('~'):
            self.outdir.set(os.path.dirname(self.paths[0]))
        self._sync_status()
        return added

    def add_files(self):
        chosen = filedialog.askopenfilenames(
            title='Choose contribution-tree exports',
            filetypes=[('Excel workbooks', '*.xlsx *.xlsm *.xls'),
                       ('All files', '*.*')])
        if chosen:
            self._add_paths(chosen)

    def scan_folder(self):
        folder = filedialog.askdirectory(title='Folder to scan for workbooks')
        if not folder:
            return
        found = []
        for base, _dirs, names in os.walk(folder):
            for name in sorted(names):
                # "~$foo.xlsx" is Excel's lock file for an open workbook, never
                # a real export, and openpyxl cannot read it.
                if name.startswith('~$'):
                    continue
                if name.lower().endswith(('.xlsx', '.xlsm', '.xls')):
                    found.append(os.path.join(base, name))
        if not found:
            messagebox.showinfo('Nothing found',
                                'No Excel workbooks under:\n' + folder)
            return
        added = self._add_paths(found)
        self._append('Scanned %s — added %d of %d workbook(s).'
                     % (folder, added, len(found)))

    def remove_selected(self):
        for index in sorted(self.listbox.curselection(), reverse=True):
            self.listbox.delete(index)
            del self.paths[index]
        self._sync_status()

    def clear_files(self):
        self.listbox.delete(0, 'end')
        self.paths = []
        self._sync_status()

    def choose_outdir(self):
        folder = filedialog.askdirectory(title='Where should the dashboards go?',
                                         initialdir=self.outdir.get() or None)
        if folder:
            self.outdir.set(folder)

    def _sync_status(self):
        if self.worker and self.worker.is_alive():
            return
        n = len(self.paths)
        self.status.configure(
            text='Ready' if not n else '%d workbook%s queued'
                                        % (n, '' if n == 1 else 's'))

    # --- logging ------------------------------------------------------------
    def _append(self, text, tag='log'):
        self.log.configure(state='normal')
        self.log.insert('end', text + '\n', tag)
        self.log.see('end')
        self.log.configure(state='disabled')

    # --- running ------------------------------------------------------------
    def _read_options(self):
        """Validate the fields, returning a dict or None after complaining."""
        def number(var, label, cast, minimum=None):
            raw = var.get().strip()
            try:
                value = cast(raw)
            except ValueError:
                messagebox.showerror(
                    'Check that value',
                    '%s needs to be a%s number — got "%s".'
                    % (label, 'n whole' if cast is int else ' ', raw))
                return None
            if minimum is not None and value < minimum:
                messagebox.showerror('Check that value',
                                     '%s cannot be below %s.' % (label, minimum))
                return None
            return value

        values = {}
        for key, var, label, cast, minimum in (
                ('levels', self.levels, 'Levels', int, 2),
                ('threshold', self.threshold, 'Threshold %', float, 0.0),
                ('max_depth', self.max_depth, 'Max depth', int, 1),
                ('max_nodes', self.max_nodes, 'Max nodes', int, 0),
                ('payload_min', self.payload_min, 'Payload min %', float, 0.0)):
            value = number(var, label, cast, minimum)
            if value is None:
                return None
            values[key] = value
        return values

    def run(self):
        if self.worker and self.worker.is_alive():
            return
        if not self.paths:
            messagebox.showinfo('Nothing to build',
                                'Add at least one contribution-tree workbook.')
            return

        options = self._read_options()
        if options is None:
            return

        outdir = self.outdir.get().strip()
        if not outdir:
            messagebox.showinfo('Where to?', 'Choose a folder for the output.')
            return
        try:
            os.makedirs(outdir, exist_ok=True)
        except OSError as exc:
            messagebox.showerror('Cannot write there', str(exc))
            return

        options['title'] = self.title.get().strip()
        options['pool'] = self.pool.get()
        options['balance'] = self.balance.get()
        options['cdn'] = self.cdn.get()
        options['open'] = self.open_when_done.get()

        self.log.configure(state='normal')
        self.log.delete('1.0', 'end')
        self.log.configure(state='disabled')
        self.run_button.configure(state='disabled')
        self.progress.configure(value=0, maximum=len(self.paths))

        paths = list(self.paths)
        self.worker = threading.Thread(
            target=self._work, args=(paths, outdir, options), daemon=True)
        self.worker.start()

    def _work(self, paths, outdir, options):
        """Worker thread: never touches Tk, only posts events to the queue."""
        put = self.events.put
        try:
            import generate_sankey
        except ImportError as exc:
            put(('line', 'Cannot import generate_sankey.py: %s' % exc, 'error'))
            put(('line', 'It has to sit next to this file, and needs pandas, '
                         'openpyxl and plotly:', 'error'))
            put(('line', '    pip install pandas openpyxl plotly', 'error'))
            put(('done', 0, len(paths)))
            return

        made = 0
        for index, path in enumerate(paths, start=1):
            stem = os.path.splitext(os.path.basename(path))[0]
            out_html = os.path.join(outdir, stem + '-dashboard.html')
            put(('line', '[%d/%d] %s' % (index, len(paths),
                                         os.path.basename(path)), 'head'))

            argv = [path, '-o', out_html,
                    '--levels', str(options['levels']),
                    '--threshold', str(options['threshold']),
                    '--max-depth', str(options['max_depth']),
                    '--max-nodes', str(options['max_nodes']),
                    '--payload-min', str(options['payload_min']),
                    # the GUI opens the result itself, once it knows the run
                    # actually succeeded
                    '--no-open']
            if options['title']:
                argv += ['--title', options['title']]
            if options['pool']:
                argv.append('--pool')
            if options['balance']:
                argv.append('--balance')
            if options['cdn']:
                argv.append('--cdn')

            writer = _QueueWriter(put)
            try:
                with contextlib.redirect_stdout(writer):
                    code = generate_sankey.main(argv)
                writer.flush()
            except SystemExit as exc:            # argparse bailing out
                writer.flush()
                code = exc.code if isinstance(exc.code, int) else 1
            except Exception:
                writer.flush()
                put(('line', traceback.format_exc().rstrip(), 'error'))
                code = 1

            if code == 0 and os.path.exists(out_html):
                made += 1
                put(('line', '  → ' + out_html, 'ok'))
                if options['open']:
                    put(('open', out_html, ''))
            else:
                put(('line', '  failed — nothing written for this workbook.',
                     'error'))
            put(('progress', index, ''))

        put(('done', made, len(paths)))

    def _drain(self):
        """Pump worker events onto the Tk thread."""
        try:
            while True:
                kind, a, b = self.events.get_nowait()
                if kind == 'line':
                    self._append(a, b or 'log')
                elif kind == 'progress':
                    self.progress.configure(value=a)
                    self.status.configure(text='Building… %d' % a)
                elif kind == 'open':
                    open_file(a)
                elif kind == 'done':
                    self._finish(a, b)
        except queue.Empty:
            pass
        self.root.after(80, self._drain)

    def _finish(self, made, total):
        self.run_button.configure(state='normal')
        self.progress.configure(value=total)
        if made == total:
            self._append('Done — %d dashboard%s written.'
                         % (made, '' if made == 1 else 's'), 'ok')
            self.status.configure(text='Done')
        else:
            self._append('Finished with problems — %d of %d written.'
                         % (made, total), 'error')
            self.status.configure(text='%d of %d' % (made, total))

    def _on_close(self):
        # the worker is a daemon, so a run in flight dies with the window
        self.root.destroy()


def main():
    root = tk.Tk()
    SankeyGUI(root)
    # Open at the natural size of the content, but never taller than the screen
    # can show — a laptop at 1366x768 would otherwise get the Build button and
    # the log pushed off the bottom edge with no hint they are there.
    root.update_idletasks()
    width = max(root.winfo_reqwidth(), 820)
    height = min(root.winfo_reqheight(), root.winfo_screenheight() - 90)
    root.geometry('%dx%d' % (width, height))
    root.mainloop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
