// Junta classes condicionais: descarta falsy (false/undefined) e une por espaço.
// Único helper de className da casa — antes duplicado em cada wrapper de ui/.
export const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
