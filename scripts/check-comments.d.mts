export interface CommentRange {
  start: number;
  end: number;
  block: boolean;
  whole: boolean;
}

export function findCommentRanges(file: string, text: string): CommentRange[];
