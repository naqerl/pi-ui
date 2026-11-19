export type CommentRange = {
  start: number;
  end: number;
  kind: "line" | "block" | "jsx";
};

export declare const JAVASCRIPT_EXTENSIONS: Set<string>;
export declare function classify(file: string): string | null;
export declare function findComments(file: string, text: string): CommentRange[];
export declare function check(repository: string): {
  file: string;
  line: string;
  text: string;
}[];
