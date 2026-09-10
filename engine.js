// Hidden Queen Chess — rules engine.
// True board state lives here. Rendering and the bot must go through
// getPublicView()/getPrivateView() rather than touching board state directly.

(function (root) {

const WHITE = 'w';
const BLACK = 'b';

const PIECE_VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

function otherColor(c) { return c === WHITE ? BLACK : WHITE; }

function inBounds(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }

function sq(r, f) { return r * 8 + f; }
function rankOf(s) { return Math.floor(s / 8); }
function fileOf(s) { return s % 8; }
function algebraic(s) {
  const f = fileOf(s), r = rankOf(s);
  return 'abcdefgh'[f] + (r + 1);
}

// Directions
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = ROOK_DIRS.concat(BISHOP_DIRS);
const KNIGHT_DELTAS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const KING_DELTAS = QUEEN_DIRS;

class Piece {
  constructor(type, color, id) {
    this.type = type;       // TRUE governing type: P,N,B,R,Q,K (a hidden queen's
                             // true type is 'Q' — see designateHiddenQueen)
    this.color = color;     // 'w' | 'b'
    this.id = id;           // stable identity across the game
    this.isHiddenQueen = false; // true only for the one disguised piece per side
    this.disguiseType = type;   // original look (piece type shown pre-reveal)
    this.revealed = false;  // once true, disguise is public knowledge forever
    this.hasMoved = false;
  }
  // The icon shown on the board for this piece, to EITHER player, until it
  // is revealed: the disguise persists for the owner too (only a UI-side
  // crown marker, visible solely to the owner, hints at the truth).
  get displayType() {
    if (this.isHiddenQueen && !this.revealed) return this.disguiseType;
    return this.type;
  }
}

class Engine {
  constructor() {
    this.board = new Array(64).fill(null);
    this.turn = WHITE;
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    this.epTarget = null; // square index behind a pawn that just double-stepped
    this.halfmoveClock = 0;
    this.fullmoveNumber = 1;
    this.history = []; // move log entries, see makeMove() for shape
    this.positionCounts = new Map(); // for threefold repetition
    this._nextId = 1;
    this.gameOver = null; // null | {result, reason}
    this.setupPhase = true;
    this.hiddenQueenId = { w: null, b: null };
    this._setupBoard();
  }

  _newId() { return this._nextId++; }

  _setupBoard() {
    const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let f = 0; f < 8; f++) {
      this.board[sq(0, f)] = new Piece(backRank[f], WHITE, this._newId());
      this.board[sq(1, f)] = new Piece('P', WHITE, this._newId());
      this.board[sq(6, f)] = new Piece('P', BLACK, this._newId());
      this.board[sq(7, f)] = new Piece(backRank[f], BLACK, this._newId());
    }
  }

  clone() {
    const e = Object.create(Engine.prototype);
    e.board = this.board.map(p => p ? Object.assign(new Piece(p.type, p.color, p.id), p) : null);
    e.turn = this.turn;
    e.castling = { ...this.castling };
    e.epTarget = this.epTarget;
    e.halfmoveClock = this.halfmoveClock;
    e.fullmoveNumber = this.fullmoveNumber;
    e.history = this.history.slice();
    e.positionCounts = new Map(this.positionCounts);
    e._nextId = this._nextId;
    e.gameOver = this.gameOver;
    e.setupPhase = this.setupPhase;
    e.hiddenQueenId = { ...this.hiddenQueenId };
    return e;
  }

  // ---------- Setup phase ----------

  // Designating a piece as the hidden queen sets its TRUE governing type to
  // 'Q' (Replace model: full queen power, no disguise-type movement left),
  // while disguiseType remembers the original icon/type shown until reveal.
  designateHiddenQueen(color, pieceId) {
    const piece = this.board.find(p => p && p.id === pieceId);
    if (!piece || piece.color !== color || piece.type === 'K') return false;
    piece.disguiseType = piece.type; // original look (may already be 'Q' — a harmless no-op pick)
    piece.type = 'Q';
    piece.isHiddenQueen = true;
    this.hiddenQueenId[color] = pieceId;
    return true;
  }

  pickRandomHiddenQueenFor(color) {
    const eligible = this.board.filter(p => p && p.color === color && p.type !== 'K' && p.type !== 'Q');
    const chosen = eligible[Math.floor(Math.random() * eligible.length)];
    this.designateHiddenQueen(color, chosen.id);
    return chosen;
  }

  maybeStartGame() {
    if (this.hiddenQueenId.w != null && this.hiddenQueenId.b != null) {
      this.setupPhase = false;
    }
  }

  // ---------- Move generation ----------

  pieceAt(s) { return this.board[s]; }

  findKing(color) {
    return this.board.findIndex(p => p && p.color === color && p.type === 'K');
  }

  // Pseudo-legal destinations (ignores own-king-in-check), with move metadata.
  pseudoMovesFor(s, board = this.board, epTarget = this.epTarget) {
    const piece = board[s];
    if (!piece) return [];
    const type = piece.type;
    const moves = [];
    const r0 = rankOf(s), f0 = fileOf(s);

    const pushSliding = (dirs) => {
      for (const [dr, df] of dirs) {
        let r = r0 + dr, f = f0 + df;
        while (inBounds(r, f)) {
          const t = sq(r, f);
          const occ = board[t];
          if (!occ) {
            moves.push({ from: s, to: t, capture: false });
          } else {
            if (occ.color !== piece.color) moves.push({ from: s, to: t, capture: true });
            break;
          }
          r += dr; f += df;
        }
      }
    };

    const pushSteps = (deltas) => {
      for (const [dr, df] of deltas) {
        const r = r0 + dr, f = f0 + df;
        if (!inBounds(r, f)) continue;
        const t = sq(r, f);
        const occ = board[t];
        if (!occ || occ.color !== piece.color) {
          moves.push({ from: s, to: t, capture: !!occ });
        }
      }
    };

    if (type === 'R') pushSliding(ROOK_DIRS);
    else if (type === 'B') pushSliding(BISHOP_DIRS);
    else if (type === 'Q') pushSliding(QUEEN_DIRS);
    else if (type === 'N') pushSteps(KNIGHT_DELTAS);
    else if (type === 'K') {
      pushSteps(KING_DELTAS);
      // Castling handled separately (needs check/attack info).
    } else if (type === 'P') {
      const dir = piece.color === WHITE ? 1 : -1;
      const startRank = piece.color === WHITE ? 1 : 6;
      const promoRank = piece.color === WHITE ? 7 : 0;
      // single forward
      const oneR = r0 + dir;
      if (inBounds(oneR, f0) && !board[sq(oneR, f0)]) {
        const t = sq(oneR, f0);
        moves.push({ from: s, to: t, capture: false, promotion: rankOf(t) === promoRank, isPawnForward: true });
        // double forward
        if (r0 === startRank) {
          const twoR = r0 + 2 * dir;
          if (!board[sq(twoR, f0)]) {
            moves.push({ from: s, to: sq(twoR, f0), capture: false, isPawnDouble: true });
          }
        }
      }
      // captures (incl en passant)
      for (const df of [-1, 1]) {
        const f = f0 + df, r = r0 + dir;
        if (!inBounds(r, f)) continue;
        const t = sq(r, f);
        const occ = board[t];
        if (occ && occ.color !== piece.color) {
          moves.push({ from: s, to: t, capture: true, promotion: rankOf(t) === promoRank, isPawnCapture: true });
        } else if (!occ && t === epTarget) {
          moves.push({ from: s, to: t, capture: true, isEnPassant: true, isPawnCapture: true });
        }
      }
    }
    return moves;
  }

  isSquareAttacked(s, byColor, board = this.board) {
    for (let i = 0; i < 64; i++) {
      const p = board[i];
      if (!p || p.color !== byColor) continue;
      if (p.type === 'P') {
        const dir = p.color === WHITE ? 1 : -1;
        const r = rankOf(i) + dir;
        for (const df of [-1, 1]) {
          const f = fileOf(i) + df;
          if (inBounds(r, f) && sq(r, f) === s) return true;
        }
        continue;
      }
      const moves = this.pseudoMovesFor(i, board, null);
      if (moves.some(m => m.to === s)) return true;
    }
    return false;
  }

  // Full legal moves for the side to move (or specified color), filtering
  // out moves that leave the mover's own king in check. Includes castling.
  legalMovesFrom(s, board = this.board, color = null, epTarget = this.epTarget, castlingRights = this.castling) {
    const piece = board[s];
    if (!piece) return [];
    const mover = color || piece.color;
    if (piece.color !== mover) return [];
    let moves = this.pseudoMovesFor(s, board, epTarget);

    if (piece.type === 'K') {
      moves = moves.concat(this._castlingMoves(s, board, mover, castlingRights));
    }

    const legal = [];
    for (const m of moves) {
      const { board: nb } = this._applyToBoard(board, m);
      const kingSq = nb.findIndex(p => p && p.color === mover && p.type === 'K');
      if (!this.isSquareAttacked(kingSq, otherColor(mover), nb)) {
        legal.push(m);
      }
    }
    return legal;
  }

  _castlingMoves(kingSq, board, color, castlingRights) {
    const moves = [];
    const rank = color === WHITE ? 0 : 7;
    if (kingSq !== sq(rank, 4)) return moves;
    const opp = otherColor(color);
    if (this.isSquareAttacked(kingSq, opp, board)) return moves; // can't castle out of check

    const kingSideRight = color === WHITE ? castlingRights.wK : castlingRights.bK;
    const queenSideRight = color === WHITE ? castlingRights.wQ : castlingRights.bQ;

    if (kingSideRight) {
      const rookSq = sq(rank, 7);
      const rook = board[rookSq];
      const isRookLike = rook && rook.color === color && (rook.type === 'R' || (rook.isHiddenQueen && rook.disguiseType === 'R'));
      if (isRookLike && !rook.hasMoved) {
        const f5 = sq(rank, 5), f6 = sq(rank, 6);
        if (!board[f5] && !board[f6] &&
            !this.isSquareAttacked(f5, opp, board) && !this.isSquareAttacked(f6, opp, board)) {
          moves.push({ from: kingSq, to: f6, capture: false, isCastle: 'K', rookFrom: rookSq, rookTo: f5 });
        }
      }
    }
    if (queenSideRight) {
      const rookSq = sq(rank, 0);
      const rook = board[rookSq];
      const isRookLike = rook && rook.color === color && (rook.type === 'R' || (rook.isHiddenQueen && rook.disguiseType === 'R'));
      if (isRookLike && !rook.hasMoved) {
        const f1 = sq(rank, 1), f2 = sq(rank, 2), f3 = sq(rank, 3);
        if (!board[f1] && !board[f2] && !board[f3] &&
            !this.isSquareAttacked(f2, opp, board) && !this.isSquareAttacked(f3, opp, board)) {
          moves.push({ from: kingSq, to: f2, capture: false, isCastle: 'Q', rookFrom: rookSq, rookTo: f3 });
        }
      }
    }
    return moves;
  }

  allLegalMoves(color, board = this.board, epTarget = this.epTarget, castlingRights = this.castling) {
    const out = [];
    for (let s = 0; s < 64; s++) {
      const p = board[s];
      if (p && p.color === color) {
        out.push(...this.legalMovesFrom(s, board, color, epTarget, castlingRights));
      }
    }
    return out;
  }

  // Apply a move to a *copy* of the board without mutating engine state.
  // Returns { board, capturedPiece }. Used only for check-legality probing.
  _applyToBoard(board, move) {
    const nb = board.slice();
    const piece = nb[move.from];
    let capturedPiece = null;
    if (move.isEnPassant) {
      const capSq = sq(rankOf(move.from), fileOf(move.to));
      capturedPiece = nb[capSq];
      nb[capSq] = null;
    } else if (move.capture) {
      capturedPiece = nb[move.to];
    }
    nb[move.to] = piece;
    nb[move.from] = null;
    if (move.isCastle) {
      const rook = nb[move.rookFrom];
      nb[move.rookTo] = rook;
      nb[move.rookFrom] = null;
    }
    return { board: nb, capturedPiece };
  }

  // ---------- Reveal logic ----------

  // Would a real piece of `discType` legally produce this exact move
  // (from -> to, capture/no-capture), from square `from`, ignoring
  // check/pin considerations (pure geometry + pawn capture/no-capture rule)?
  _moveMatchesDisguise(discType, move, color) {
    const from = move.from, to = move.to;
    const dr = rankOf(to) - rankOf(from);
    const df = fileOf(to) - fileOf(from);
    switch (discType) {
      case 'R':
        return (dr === 0 || df === 0) && !(dr === 0 && df === 0);
      case 'B':
        return Math.abs(dr) === Math.abs(df) && dr !== 0;
      case 'N':
        return (Math.abs(dr) === 1 && Math.abs(df) === 2) || (Math.abs(dr) === 2 && Math.abs(df) === 1);
      case 'P': {
        const dir = color === WHITE ? 1 : -1;
        if (df === 0) {
          if (move.capture) return false; // forward move must not capture
          if (dr === dir) return true;
          const startRank = color === WHITE ? 1 : 6;
          if (dr === 2 * dir && rankOf(from) === startRank) return true;
          return false;
        } else if (Math.abs(df) === 1 && dr === dir) {
          return !!move.capture; // diagonal must be a capture
        }
        return false;
      }
      case 'Q':
        return true; // already the queen; a no-op disguise
      default:
        return false;
    }
  }

  // Would making this move reveal the mover's hidden queen? Read-only,
  // does not mutate state. Used by the bot's deception heuristic to weigh
  // candidate moves for its OWN side without duplicating reveal logic.
  wouldRevealHiddenQueen(move) {
    const piece = this.board[move.from];
    if (!piece || !piece.isHiddenQueen || piece.revealed) return false;
    const legal = this.legalMovesFrom(move.from);
    const chosen = legal.find(m => m.to === move.to);
    if (!chosen) return false;
    if (chosen.isCastle) return false;
    return !this._moveMatchesDisguise(piece.disguiseType, chosen, piece.color);
  }

  // ---------- Making a move (mutates real engine state) ----------

  // move: {from, to, promotion?: 'Q'|'R'|'B'|'N'}
  makeMove(move) {
    if (this.gameOver) return { ok: false, reason: 'game_over' };
    const piece = this.board[move.from];
    if (!piece || piece.color !== this.turn) return { ok: false, reason: 'no_piece' };

    const legal = this.legalMovesFrom(move.from);
    const chosen = legal.find(m => m.to === move.to);
    if (!chosen) return { ok: false, reason: 'illegal' };

    const color = piece.color;
    const wasHidden = piece.isHiddenQueen && !piece.revealed;
    const discType = piece.disguiseType;

    // Determine reveal BEFORE mutating (uses true move geometry).
    let revealedNow = false;
    if (wasHidden) {
      const matchesDisguise = chosen.isCastle
        ? true // castling never reveals a disguised rook
        : this._moveMatchesDisguise(discType, chosen, color);
      if (!matchesDisguise) revealedNow = true;
    }

    // Snapshot captured piece info (for tray + hidden-queen-capture reveal)
    let capturedPiece = null;
    if (chosen.isEnPassant) {
      const capSq = sq(rankOf(chosen.from), fileOf(chosen.to));
      capturedPiece = this.board[capSq];
      this.board[capSq] = null;
    } else if (chosen.capture) {
      capturedPiece = this.board[chosen.to];
    }
    const capturedWasHiddenQueen = !!(capturedPiece && capturedPiece.isHiddenQueen && !capturedPiece.revealed);
    if (capturedPiece && capturedPiece.isHiddenQueen) capturedPiece.revealed = true; // reveal on capture (decision)

    // Move the piece
    this.board[chosen.to] = piece;
    this.board[chosen.from] = null;
    piece.hasMoved = true;

    if (chosen.isCastle) {
      const rook = this.board[chosen.rookFrom];
      this.board[chosen.rookTo] = rook;
      this.board[chosen.rookFrom] = null;
      if (rook) rook.hasMoved = true;
    }

    // Promotion: only an ordinary (non-hidden, or already-revealed) pawn ever
    // carries the promotion flag here, since a still-hidden pawn moves via
    // queen geometry (pseudoMovesFor's 'Q' branch), never the 'P' branch.
    if (chosen.promotion) {
      const promoType = move.promotion && ['Q', 'R', 'B', 'N'].includes(move.promotion) ? move.promotion : 'Q';
      piece.type = promoType;
    }
    // A disguised-but-still-hidden pawn reaching the back rank force-reveals:
    // a real pawn can never remain a pawn there.
    let forcedPawnReveal = false;
    if (wasHidden && !revealedNow && discType === 'P') {
      const destRank = rankOf(chosen.to);
      if (destRank === 0 || destRank === 7) forcedPawnReveal = true;
    }

    if (revealedNow || forcedPawnReveal) {
      piece.revealed = true;
    }

    // En passant target update
    this.epTarget = chosen.isPawnDouble ? sq((rankOf(chosen.from) + rankOf(chosen.to)) / 2, fileOf(chosen.from)) : null;

    // Castling rights update
    if (piece.type === 'K' || chosen.isCastle) {
      if (color === WHITE) { this.castling.wK = false; this.castling.wQ = false; }
      else { this.castling.bK = false; this.castling.bQ = false; }
    }
    const clearRookRights = (s) => {
      if (s === sq(0, 0)) this.castling.wQ = false;
      if (s === sq(0, 7)) this.castling.wK = false;
      if (s === sq(7, 0)) this.castling.bQ = false;
      if (s === sq(7, 7)) this.castling.bK = false;
    };
    clearRookRights(chosen.from);
    clearRookRights(chosen.to);

    // Halfmove clock (50-move rule): reset on capture or pawn move
    if (chosen.capture || piece.type === 'P' || chosen.promotion) {
      this.halfmoveClock = 0;
    } else {
      this.halfmoveClock++;
    }
    if (color === BLACK) this.fullmoveNumber++;

    const record = {
      from: chosen.from, to: chosen.to, color,
      pieceTrueType: piece.type,
      pieceApparentTypeAtMoveTime: (wasHidden && !revealedNow && !forcedPawnReveal) ? discType : piece.type,
      wasHiddenAndRevealedThisMove: revealedNow || forcedPawnReveal,
      isHiddenQueenPiece: piece.isHiddenQueen,
      pieceId: piece.id,
      capture: !!chosen.capture,
      capturedTrueType: capturedPiece ? capturedPiece.type : null,
      capturedWasHiddenQueen,
      isCastle: chosen.isCastle || null,
      isEnPassant: !!chosen.isEnPassant,
      promotion: chosen.promotion ? piece.type : null,
      forcedPawnReveal,
    };
    this.history.push(record);

    this.turn = otherColor(this.turn);

    const posKey = this._positionKey();
    this.positionCounts.set(posKey, (this.positionCounts.get(posKey) || 0) + 1);

    this._updateGameOver();

    return { ok: true, record };
  }

  _positionKey() {
    // Board + turn + castling rights + ep target (true types+colors only;
    // disguise/reveal visuals don't affect chess position legality).
    let s = this.turn;
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      s += p ? p.color + p.type : '.';
    }
    s += JSON.stringify(this.castling) + '|' + this.epTarget;
    return s;
  }

  _updateGameOver() {
    const color = this.turn;
    const moves = this.allLegalMoves(color);
    const kingSq = this.findKing(color);
    const inCheck = this.isSquareAttacked(kingSq, otherColor(color));
    if (moves.length === 0) {
      this.gameOver = inCheck
        ? { result: color === WHITE ? 'black_wins' : 'white_wins', reason: 'checkmate' }
        : { result: 'draw', reason: 'stalemate' };
      return;
    }
    if (this.halfmoveClock >= 100) {
      this.gameOver = { result: 'draw', reason: 'fifty_move' };
      return;
    }
    if (this.positionCounts.get(this._positionKey()) >= 3) {
      this.gameOver = { result: 'draw', reason: 'threefold_repetition' };
      return;
    }
    if (this._insufficientMaterial()) {
      this.gameOver = { result: 'draw', reason: 'insufficient_material' };
      return;
    }
    this.gameOver = null;
  }

  _insufficientMaterial() {
    const pieces = this.board.filter(Boolean);
    if (pieces.some(p => ['P', 'R', 'Q'].includes(p.type))) return false;
    const minors = pieces.filter(p => p.type === 'N' || p.type === 'B');
    if (minors.length <= 1) return true; // K v K, or K v K+minor
    if (minors.length === 2 && minors.every(p => p.type === 'B')) {
      const squareColors = minors.map(p => {
        const s = this.board.indexOf(p);
        return (rankOf(s) + fileOf(s)) % 2;
      });
      if (squareColors[0] === squareColors[1] && minors[0].color !== minors[1].color) {
        return true; // K+B v K+B, same-colored bishops
      }
    }
    return false;
  }

  isInCheck(color) {
    return this.isSquareAttacked(this.findKing(color), otherColor(color));
  }

  // ---------- Views ----------

  // What `viewerColor` is allowed to see of the WHOLE board (both sides):
  // the disguise icon is shown to everyone pre-reveal (even the owner —
  // only the owner also gets the isHiddenQueen flag, for a UI crown marker);
  // true type is shown once revealed or for an ordinary (non-hidden) piece.
  getPublicView(viewerColor) {
    return this.board.map(p => {
      if (!p) return null;
      return {
        type: p.displayType,
        color: p.color,
        id: p.id,
        isHiddenQueen: p.isHiddenQueen && (p.revealed || p.color === viewerColor),
        revealed: p.revealed,
        hasMoved: p.hasMoved,
      };
    });
  }

  // Full truth for one side only — used by the bot for ITS OWN pieces, and
  // never for the opponent's (see bot.js: the human's true types must never
  // be queried through this).
  getPrivateView(color) {
    return this.board.map(p => {
      if (!p || p.color !== color) return null;
      return { type: p.type, color: p.color, id: p.id, isHiddenQueen: p.isHiddenQueen, revealed: p.revealed, hasMoved: p.hasMoved };
    });
  }
}

const EngineExports = {
  Engine, WHITE, BLACK, PIECE_VALUE, sq, rankOf, fileOf, algebraic, otherColor,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EngineExports;
} else {
  root.HiddenQueenEngine = EngineExports;
}

})(typeof window !== 'undefined' ? window : globalThis);
