//! A compact VT100/xterm screen emulator for the TUI terminal panel. It
//! maintains a styled character grid so cursor-addressed programs (top, vim,
//! progress bars) render correctly inside the panel instead of as a raw
//! scrolling transcript. Std-only so the dependency-light test harness can
//! prove its behaviour.

const TAB_STOP: usize = 8;
const MAX_PARAMS: usize = 16;

/// The last `count` lines of a terminal transcript, raw escapes included —
/// the cheap seed for a freshly focused terminal view.
pub fn tail_lines(text: &str, count: usize) -> &str {
    // A trailing newline ends the last line; it does not start a new one.
    let scan_end = text.len().saturating_sub(usize::from(text.ends_with('\n')));
    let mut seen = 0;
    for (index, byte) in text.as_bytes()[..scan_end].iter().enumerate().rev() {
        if *byte == b'\n' {
            seen += 1;
            if seen >= count {
                return &text[index + 1..];
            }
        }
    }
    text
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

/// A horizontal stretch of same-styled text — the unit scrollback rows are
/// stored in and screen rows are serialized as for the GUI renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub text: String,
    pub style: Style,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cell {
    ch: char,
    style: Style,
}

/// Trailing default-styled blanks trimmed, remaining cells merged by style.
fn cells_to_runs(row: &[Cell]) -> Vec<Run> {
    let mut end = row.len();
    while end > 0 && row[end - 1].ch == ' ' && row[end - 1].style == Style::default() {
        end -= 1;
    }
    let mut runs: Vec<Run> = Vec::new();
    for cell in &row[..end] {
        match runs.last_mut() {
            Some(run) if run.style == cell.style => run.text.push(cell.ch),
            _ => runs.push(Run { text: cell.ch.to_string(), style: cell.style }),
        }
    }
    runs
}

const DEFAULT_SCROLLBACK_LIMIT: usize = 4000;

impl Default for Cell {
    fn default() -> Self {
        Cell { ch: ' ', style: Style::default() }
    }
}

enum ParseState {
    Ground,
    Escape,
    Csi { private: Option<char>, params: Vec<u16>, current: u16, has_current: bool, intermediate: Option<char> },
    /// OSC and DCS strings are skipped up to BEL or ST.
    SkipString { escape_pending: bool },
    Charset,
}

pub struct VtScreen {
    cols: usize,
    rows: usize,
    grid: Vec<Vec<Cell>>,
    saved_main: Option<(Vec<Vec<Cell>>, (usize, usize))>,
    cursor_x: usize,
    cursor_y: usize,
    saved_cursor: (usize, usize),
    style: Style,
    scroll_top: usize,
    scroll_bottom: usize, // inclusive
    pending_wrap: bool,
    pub cursor_visible: bool,
    pub application_cursor_keys: bool,
    pub bracketed_paste: bool,
    mouse_tracking_modes: u8,
    pub mouse_sgr: bool,
    autowrap: bool,
    state: ParseState,
    utf8_pending: Vec<u8>,
    // Rows scrolled off the top of the main screen, stored as styled runs.
    // `scrollback_trimmed` counts rows dropped by the cap so surviving rows
    // keep stable absolute indices.
    scrollback: std::collections::VecDeque<Vec<Run>>,
    scrollback_limit: usize,
    scrollback_trimmed: usize,
}

impl VtScreen {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        VtScreen {
            cols,
            rows,
            grid: vec![vec![Cell::default(); cols]; rows],
            saved_main: None,
            cursor_x: 0,
            cursor_y: 0,
            saved_cursor: (0, 0),
            style: Style::default(),
            scroll_top: 0,
            scroll_bottom: rows - 1,
            pending_wrap: false,
            cursor_visible: true,
            application_cursor_keys: false,
            bracketed_paste: false,
            mouse_tracking_modes: 0,
            mouse_sgr: false,
            autowrap: true,
            state: ParseState::Ground,
            utf8_pending: Vec::new(),
            scrollback: std::collections::VecDeque::new(),
            scrollback_limit: DEFAULT_SCROLLBACK_LIMIT,
            scrollback_trimmed: 0,
        }
    }

    pub fn set_scrollback_limit(&mut self, limit: usize) {
        self.scrollback_limit = limit.clamp(0, 100_000);
        self.trim_scrollback();
    }

    fn trim_scrollback(&mut self) {
        while self.scrollback.len() > self.scrollback_limit {
            self.scrollback.pop_front();
            self.scrollback_trimmed += 1;
        }
    }

    fn push_scrollback(&mut self, row: &[Cell]) {
        if self.saved_main.is_some() || self.scrollback_limit == 0 {
            return;
        }
        self.scrollback.push_back(cells_to_runs(row));
        self.trim_scrollback();
    }

    /// Total rows ever scrolled off the main screen (including trimmed ones).
    pub fn scrollback_len(&self) -> usize {
        self.scrollback_trimmed + self.scrollback.len()
    }

    /// Absolute index of the oldest row still stored.
    pub fn scrollback_start(&self) -> usize {
        self.scrollback_trimmed
    }

    /// Stored rows for the absolute range `[start, start + count)`, clamped
    /// to what is still stored.
    pub fn scrollback_runs(&self, start: usize, count: usize) -> Vec<Vec<Run>> {
        let first = start.max(self.scrollback_trimmed) - self.scrollback_trimmed;
        let last = start
            .saturating_add(count)
            .max(self.scrollback_trimmed)
            .saturating_sub(self.scrollback_trimmed)
            .min(self.scrollback.len());
        if first >= last {
            return Vec::new();
        }
        self.scrollback.range(first..last).cloned().collect()
    }

    /// The live screen grid as one styled-run row per grid row.
    pub fn styled_runs(&self) -> Vec<Vec<Run>> {
        self.grid.iter().map(|row| cells_to_runs(row)).collect()
    }

    pub fn size(&self) -> (usize, usize) {
        (self.cols, self.rows)
    }

    pub fn cursor(&self) -> (usize, usize) {
        (self.cursor_x.min(self.cols - 1), self.cursor_y)
    }

    pub fn alternate_screen(&self) -> bool {
        self.saved_main.is_some()
    }

    pub fn mouse_tracking(&self) -> bool {
        self.mouse_tracking_modes != 0
    }

    fn set_mouse_tracking(&mut self, mode: u16, enable: bool) {
        let bit = match mode {
            1000 => 1,
            1002 => 2,
            1003 => 4,
            _ => return,
        };
        if enable {
            self.mouse_tracking_modes |= bit;
        } else {
            self.mouse_tracking_modes &= !bit;
        }
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        for row in &mut self.grid {
            row.resize(cols, Cell::default());
        }
        while self.grid.len() < rows {
            self.grid.push(vec![Cell::default(); cols]);
        }
        while self.grid.len() > rows {
            // Prefer dropping blank bottom rows so recent content survives.
            let last_is_blank = self.grid.last().is_some_and(|row| row.iter().all(|cell| cell.ch == ' '));
            if last_is_blank && self.cursor_y + 1 < self.grid.len() {
                self.grid.pop();
            } else {
                let removed = self.grid.remove(0);
                self.push_scrollback(&removed);
                self.cursor_y = self.cursor_y.saturating_sub(1);
            }
        }
        self.cols = cols;
        self.rows = rows;
        self.scroll_top = 0;
        self.scroll_bottom = rows - 1;
        self.cursor_x = self.cursor_x.min(cols - 1);
        self.cursor_y = self.cursor_y.min(rows - 1);
        self.pending_wrap = false;
    }

    /// Feed raw PTY bytes; incomplete trailing UTF-8 is held for the next call.
    pub fn feed(&mut self, bytes: &[u8]) {
        let mut data = std::mem::take(&mut self.utf8_pending);
        data.extend_from_slice(bytes);
        match std::str::from_utf8(&data) {
            Ok(text) => {
                let owned = text.to_string();
                self.feed_str(&owned);
            }
            Err(error) => {
                let valid = error.valid_up_to();
                let owned = String::from_utf8_lossy(&data[..valid]).into_owned();
                self.feed_str(&owned);
                if error.error_len().is_none() && data.len() - valid < 4 {
                    self.utf8_pending = data[valid..].to_vec();
                } else {
                    self.feed_str("\u{fffd}");
                }
            }
        }
    }

    pub fn feed_str(&mut self, text: &str) {
        for ch in text.chars() {
            self.feed_char(ch);
        }
    }

    fn feed_char(&mut self, ch: char) {
        match &mut self.state {
            ParseState::Ground => match ch {
                '\u{1b}' => self.state = ParseState::Escape,
                '\r' => {
                    self.cursor_x = 0;
                    self.pending_wrap = false;
                }
                '\n' | '\u{b}' | '\u{c}' => self.line_feed(),
                '\u{8}' => {
                    self.cursor_x = self.cursor_x.saturating_sub(1);
                    self.pending_wrap = false;
                }
                '\t' => {
                    let next = ((self.cursor_x / TAB_STOP) + 1) * TAB_STOP;
                    self.cursor_x = next.min(self.cols - 1);
                    self.pending_wrap = false;
                }
                '\u{7}' | '\u{0}' | '\u{e}' | '\u{f}' => {}
                ch if (ch as u32) < 0x20 => {}
                ch => self.print_char(ch),
            },
            ParseState::Escape => match ch {
                '[' => {
                    self.state = ParseState::Csi {
                        private: None,
                        params: Vec::new(),
                        current: 0,
                        has_current: false,
                        intermediate: None,
                    };
                }
                ']' | 'P' | '^' | '_' | 'X' => self.state = ParseState::SkipString { escape_pending: false },
                '(' | ')' | '*' | '+' => self.state = ParseState::Charset,
                '7' => {
                    self.saved_cursor = (self.cursor_x, self.cursor_y);
                    self.state = ParseState::Ground;
                }
                '8' => {
                    let (x, y) = self.saved_cursor;
                    self.cursor_x = x.min(self.cols - 1);
                    self.cursor_y = y.min(self.rows - 1);
                    self.pending_wrap = false;
                    self.state = ParseState::Ground;
                }
                'M' => {
                    self.reverse_index();
                    self.state = ParseState::Ground;
                }
                'D' => {
                    self.line_feed();
                    self.state = ParseState::Ground;
                }
                'E' => {
                    self.cursor_x = 0;
                    self.line_feed();
                    self.state = ParseState::Ground;
                }
                'c' => {
                    // Full reset clears the screen but history survives.
                    let (cols, rows) = (self.cols, self.rows);
                    let scrollback = std::mem::take(&mut self.scrollback);
                    let trimmed = self.scrollback_trimmed;
                    let limit = self.scrollback_limit;
                    *self = VtScreen::new(cols, rows);
                    self.scrollback = scrollback;
                    self.scrollback_trimmed = trimmed;
                    self.scrollback_limit = limit;
                }
                _ => self.state = ParseState::Ground,
            },
            ParseState::Charset => self.state = ParseState::Ground,
            ParseState::SkipString { escape_pending } => match ch {
                '\u{7}' => self.state = ParseState::Ground,
                '\u{1b}' => *escape_pending = true,
                '\\' if *escape_pending => self.state = ParseState::Ground,
                _ => *escape_pending = false,
            },
            ParseState::Csi { private, params, current, has_current, intermediate } => match ch {
                '0'..='9' => {
                    *current = current.saturating_mul(10).saturating_add(ch as u16 - '0' as u16);
                    *has_current = true;
                }
                ';' | ':' => {
                    if params.len() < MAX_PARAMS {
                        params.push(*current);
                    }
                    *current = 0;
                    *has_current = false;
                }
                '?' | '>' | '=' | '<' if params.is_empty() && !*has_current => *private = Some(ch),
                ' '..='/' => *intermediate = Some(ch),
                final_byte if ('\u{40}'..='\u{7e}').contains(&final_byte) => {
                    if *has_current || params.is_empty() {
                        if params.len() < MAX_PARAMS {
                            params.push(*current);
                        }
                    }
                    let private = *private;
                    let params = std::mem::take(params);
                    self.state = ParseState::Ground;
                    self.dispatch_csi(private, &params, final_byte);
                }
                _ => self.state = ParseState::Ground,
            },
        }
    }

    fn print_char(&mut self, ch: char) {
        if self.pending_wrap && self.autowrap {
            self.cursor_x = 0;
            self.line_feed();
        }
        self.pending_wrap = false;
        let x = self.cursor_x.min(self.cols - 1);
        let y = self.cursor_y.min(self.rows - 1);
        self.grid[y][x] = Cell { ch, style: self.style };
        if self.cursor_x + 1 >= self.cols {
            self.pending_wrap = true;
            self.cursor_x = self.cols - 1;
        } else {
            self.cursor_x += 1;
        }
    }

    fn line_feed(&mut self) {
        self.pending_wrap = false;
        if self.cursor_y == self.scroll_bottom {
            self.scroll_up(1);
        } else if self.cursor_y + 1 < self.rows {
            self.cursor_y += 1;
        }
    }

    fn reverse_index(&mut self) {
        self.pending_wrap = false;
        if self.cursor_y == self.scroll_top {
            self.scroll_down(1);
        } else {
            self.cursor_y = self.cursor_y.saturating_sub(1);
        }
    }

    fn scroll_up(&mut self, count: usize) {
        for _ in 0..count {
            let removed = self.grid.remove(self.scroll_top);
            if self.scroll_top == 0 {
                self.push_scrollback(&removed);
            }
            self.grid.insert(self.scroll_bottom, vec![Cell::default(); self.cols]);
        }
    }

    fn scroll_down(&mut self, count: usize) {
        for _ in 0..count {
            self.grid.remove(self.scroll_bottom);
            self.grid.insert(self.scroll_top, vec![Cell::default(); self.cols]);
        }
    }

    fn clear_region(&mut self, from: (usize, usize), to: (usize, usize)) {
        // Inclusive linear range over the grid in row-major order.
        for y in from.1..=to.1.min(self.rows - 1) {
            let start = if y == from.1 { from.0 } else { 0 };
            let end = if y == to.1 { to.0 } else { self.cols - 1 };
            for x in start..=end.min(self.cols - 1) {
                self.grid[y][x] = Cell::default();
            }
        }
    }

    fn dispatch_csi(&mut self, private: Option<char>, params: &[u16], action: char) {
        let arg = |index: usize, default: u16| -> usize {
            let value = params.get(index).copied().unwrap_or(default);
            (if value == 0 { default } else { value }) as usize
        };
        match action {
            'A' => {
                self.cursor_y = self.cursor_y.saturating_sub(arg(0, 1)).max(self.scroll_top.min(self.cursor_y));
                self.pending_wrap = false;
            }
            'B' | 'e' => {
                self.cursor_y = (self.cursor_y + arg(0, 1)).min(self.rows - 1);
                self.pending_wrap = false;
            }
            'C' | 'a' => {
                self.cursor_x = (self.cursor_x + arg(0, 1)).min(self.cols - 1);
                self.pending_wrap = false;
            }
            'D' => {
                self.cursor_x = self.cursor_x.saturating_sub(arg(0, 1));
                self.pending_wrap = false;
            }
            'E' => {
                self.cursor_x = 0;
                self.cursor_y = (self.cursor_y + arg(0, 1)).min(self.rows - 1);
            }
            'F' => {
                self.cursor_x = 0;
                self.cursor_y = self.cursor_y.saturating_sub(arg(0, 1));
            }
            'G' | '`' => {
                self.cursor_x = arg(0, 1).saturating_sub(1).min(self.cols - 1);
                self.pending_wrap = false;
            }
            'H' | 'f' => {
                self.cursor_y = arg(0, 1).saturating_sub(1).min(self.rows - 1);
                self.cursor_x = arg(1, 1).saturating_sub(1).min(self.cols - 1);
                self.pending_wrap = false;
            }
            'd' => {
                self.cursor_y = arg(0, 1).saturating_sub(1).min(self.rows - 1);
                self.pending_wrap = false;
            }
            'J' => {
                let cursor = (self.cursor_x.min(self.cols - 1), self.cursor_y);
                match params.first().copied().unwrap_or(0) {
                    0 => self.clear_region(cursor, (self.cols - 1, self.rows - 1)),
                    1 => self.clear_region((0, 0), cursor),
                    _ => self.clear_region((0, 0), (self.cols - 1, self.rows - 1)),
                }
            }
            'K' => {
                let y = self.cursor_y;
                let x = self.cursor_x.min(self.cols - 1);
                match params.first().copied().unwrap_or(0) {
                    0 => self.clear_region((x, y), (self.cols - 1, y)),
                    1 => self.clear_region((0, y), (x, y)),
                    _ => self.clear_region((0, y), (self.cols - 1, y)),
                }
            }
            'L' => {
                let count = arg(0, 1);
                if self.cursor_y >= self.scroll_top && self.cursor_y <= self.scroll_bottom {
                    for _ in 0..count.min(self.rows) {
                        self.grid.remove(self.scroll_bottom);
                        self.grid.insert(self.cursor_y, vec![Cell::default(); self.cols]);
                    }
                }
            }
            'M' => {
                let count = arg(0, 1);
                if self.cursor_y >= self.scroll_top && self.cursor_y <= self.scroll_bottom {
                    for _ in 0..count.min(self.rows) {
                        self.grid.remove(self.cursor_y);
                        self.grid.insert(self.scroll_bottom, vec![Cell::default(); self.cols]);
                    }
                }
            }
            'P' => {
                let count = arg(0, 1);
                let y = self.cursor_y;
                let x = self.cursor_x.min(self.cols - 1);
                for _ in 0..count {
                    self.grid[y].remove(x);
                    self.grid[y].push(Cell::default());
                }
            }
            '@' => {
                let count = arg(0, 1);
                let y = self.cursor_y;
                let x = self.cursor_x.min(self.cols - 1);
                for _ in 0..count {
                    self.grid[y].insert(x, Cell::default());
                    self.grid[y].pop();
                }
            }
            'X' => {
                let count = arg(0, 1);
                let y = self.cursor_y;
                let x = self.cursor_x.min(self.cols - 1);
                for offset in 0..count {
                    if x + offset < self.cols {
                        self.grid[y][x + offset] = Cell::default();
                    }
                }
            }
            'S' => self.scroll_up(arg(0, 1)),
            'T' => self.scroll_down(arg(0, 1)),
            'r' => {
                let top = arg(0, 1).saturating_sub(1).min(self.rows - 1);
                let bottom = arg(1, self.rows as u16).saturating_sub(1).min(self.rows - 1);
                if top < bottom {
                    self.scroll_top = top;
                    self.scroll_bottom = bottom;
                }
                self.cursor_x = 0;
                self.cursor_y = self.scroll_top;
            }
            'h' | 'l' => {
                let enable = action == 'h';
                if private == Some('?') {
                    for param in params {
                        match param {
                            1 => self.application_cursor_keys = enable,
                            25 => self.cursor_visible = enable,
                            7 => self.autowrap = enable,
                            47 | 1047 | 1049 => self.set_alt_screen(enable),
                            1000 | 1002 | 1003 => self.set_mouse_tracking(*param, enable),
                            1006 => self.mouse_sgr = enable,
                            2004 => self.bracketed_paste = enable,
                            _ => {}
                        }
                    }
                }
            }
            'm' => self.apply_sgr(params),
            's' => self.saved_cursor = (self.cursor_x, self.cursor_y),
            'u' => {
                let (x, y) = self.saved_cursor;
                self.cursor_x = x.min(self.cols - 1);
                self.cursor_y = y.min(self.rows - 1);
            }
            _ => {}
        }
    }

    fn set_alt_screen(&mut self, enable: bool) {
        if enable {
            if self.saved_main.is_none() {
                let grid = std::mem::replace(&mut self.grid, vec![vec![Cell::default(); self.cols]; self.rows]);
                self.saved_main = Some((grid, (self.cursor_x, self.cursor_y)));
                self.cursor_x = 0;
                self.cursor_y = 0;
            }
        } else if let Some((grid, cursor)) = self.saved_main.take() {
            self.grid = grid;
            for row in &mut self.grid {
                row.resize(self.cols, Cell::default());
            }
            self.grid.resize(self.rows, vec![Cell::default(); self.cols]);
            self.cursor_x = cursor.0.min(self.cols - 1);
            self.cursor_y = cursor.1.min(self.rows - 1);
        }
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.pending_wrap = false;
    }

    fn apply_sgr(&mut self, params: &[u16]) {
        let mut index = 0;
        while index < params.len() {
            match params[index] {
                0 => self.style = Style::default(),
                1 => self.style.bold = true,
                2 => self.style.dim = true,
                3 => self.style.italic = true,
                4 => self.style.underline = true,
                7 => self.style.inverse = true,
                22 => {
                    self.style.bold = false;
                    self.style.dim = false;
                }
                23 => self.style.italic = false,
                24 => self.style.underline = false,
                27 => self.style.inverse = false,
                30..=37 => self.style.fg = Color::Indexed(params[index] as u8 - 30),
                39 => self.style.fg = Color::Default,
                40..=47 => self.style.bg = Color::Indexed(params[index] as u8 - 40),
                49 => self.style.bg = Color::Default,
                90..=97 => self.style.fg = Color::Indexed(params[index] as u8 - 90 + 8),
                100..=107 => self.style.bg = Color::Indexed(params[index] as u8 - 100 + 8),
                38 | 48 => {
                    let is_fg = params[index] == 38;
                    let color = match params.get(index + 1) {
                        Some(5) => {
                            let value = Color::Indexed(params.get(index + 2).copied().unwrap_or(0) as u8);
                            index += 2;
                            Some(value)
                        }
                        Some(2) => {
                            let value = Color::Rgb(
                                params.get(index + 2).copied().unwrap_or(0) as u8,
                                params.get(index + 3).copied().unwrap_or(0) as u8,
                                params.get(index + 4).copied().unwrap_or(0) as u8,
                            );
                            index += 4;
                            Some(value)
                        }
                        _ => None,
                    };
                    if let Some(color) = color {
                        if is_fg {
                            self.style.fg = color;
                        } else {
                            self.style.bg = color;
                        }
                    }
                }
                _ => {}
            }
            index += 1;
        }
    }

    pub fn plain_lines(&self) -> Vec<String> {
        self.grid
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| cell.ch)
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect()
    }

    /// Styled ANSI rows, each reset-terminated. `cursor_at` draws an inverse
    /// cursor cell at the given position (the panel's own cursor display).
    pub fn styled_lines(&self, cursor_at: Option<(usize, usize)>) -> Vec<String> {
        self.grid
            .iter()
            .enumerate()
            .map(|(y, row)| {
                let mut out = String::new();
                let mut active = Style::default();
                let mut style_open = false;
                // Trailing blank default-style cells are trimmed per row.
                let mut end = row.len();
                while end > 0 && row[end - 1].ch == ' ' && row[end - 1].style == Style::default() {
                    end -= 1;
                }
                if let Some((cx, cy)) = cursor_at {
                    if cy == y {
                        end = end.max((cx + 1).min(row.len()));
                    }
                }
                for (x, cell) in row[..end].iter().enumerate() {
                    let mut style = cell.style;
                    if cursor_at == Some((x, y)) {
                        style.inverse = !style.inverse;
                    }
                    if style != active || (!style_open && style != Style::default()) {
                        out.push_str("\u{1b}[0m");
                        out.push_str(&sgr_sequence(&style));
                        active = style;
                        style_open = style != Style::default();
                    }
                    out.push(cell.ch);
                }
                if style_open || end > 0 {
                    out.push_str("\u{1b}[0m");
                }
                out
            })
            .collect()
    }
}

fn sgr_sequence(style: &Style) -> String {
    let mut codes: Vec<String> = Vec::new();
    if style.bold {
        codes.push("1".to_string());
    }
    if style.dim {
        codes.push("2".to_string());
    }
    if style.italic {
        codes.push("3".to_string());
    }
    if style.underline {
        codes.push("4".to_string());
    }
    if style.inverse {
        codes.push("7".to_string());
    }
    match style.fg {
        Color::Default => {}
        Color::Indexed(value) if value < 8 => codes.push(format!("{}", 30 + value)),
        Color::Indexed(value) if value < 16 => codes.push(format!("{}", 90 + value - 8)),
        Color::Indexed(value) => codes.push(format!("38;5;{value}")),
        Color::Rgb(r, g, b) => codes.push(format!("38;2;{r};{g};{b}")),
    }
    match style.bg {
        Color::Default => {}
        Color::Indexed(value) if value < 8 => codes.push(format!("{}", 40 + value)),
        Color::Indexed(value) if value < 16 => codes.push(format!("{}", 100 + value - 8)),
        Color::Indexed(value) => codes.push(format!("48;5;{value}")),
        Color::Rgb(r, g, b) => codes.push(format!("48;2;{r};{g};{b}")),
    }
    if codes.is_empty() {
        String::new()
    } else {
        format!("\u{1b}[{}m", codes.join(";"))
    }
}
