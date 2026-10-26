export const greet = (name: string): string => {
  return `Hello, ${name}`;
};

export const add = (a: number, b: number) => a + b;

let handler = (req: string) => {
  return req.toUpperCase();
};

// Unnamed default export arrow -- should be skipped
export default (x: number) => x * 2;

// Callback arrow -- should be skipped (no variable declaration parent)
const results = [1, 2, 3].map((n) => n * 2);
