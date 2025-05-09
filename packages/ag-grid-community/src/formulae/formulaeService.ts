import { AgColumn, BeanStub, IEventEmitter, NamedBean, RowNode } from '../main';

const getFormula = (column: AgColumn, node: RowNode): string | null => {
    if (!node.data) {
        return null;
    }

    const valueGetter = column.colDef.valueGetter;
    const field = column.colDef.field;

    let potentialFormula: string | null = null;
    if (field) {
        potentialFormula = node.data[field];
    } else if (valueGetter && typeof valueGetter === 'function') {
        potentialFormula = valueGetter({ data: node.data, column, node } as any);
    } else {
        return null;
    }

    if (typeof potentialFormula === 'string' && potentialFormula.startsWith('=')) {
        return potentialFormula;
    }

    return null;
};

interface Cell {
    rowId: string;
    columnId: string;
}

type FormulaOperand = FormulaTree | Cell | number | string | boolean;

interface FormulaTree {
    operation: string;
    operands: FormulaOperand[];
}

const parseOperand = (operand: string): Cell | number | string | boolean | null => {
    const trimmed = operand.trim();
    // string operand
    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
        return trimmed.slice(1, -1);
    }

    if (trimmed === 'true') {
        return true;
    }
    if (trimmed === 'false') {
        return false;
    }

    // better num passing probs
    const num = Number(trimmed);
    if (!isNaN(num)) {
        return num;
    }

    const [row, column] = trimmed.split(':'); // cannot allow : in col or row ids
    if (row && column) {
        return {
            rowId: row,
            columnId: column,
        };
    }

    return null;
};

/*
 * Parse a formula string into a tree structure.
 */
const parse = (formula: string): FormulaTree | null => {
    const resultStack: (FormulaTree & { startIndex: number })[] = [];
    let lastProcessedIndex = 1; // the last processed index

    // start at 1 to skip the preceding '='
    for (let i = 1; i < formula.length; i++) {
        const char = formula[i];
        switch (char) {
            case '(': {
                const lastStack = resultStack[resultStack.length - 1];
                const firstIndex = lastStack ? lastStack.startIndex : 1;
                resultStack.push({
                    operation: formula.slice(firstIndex, i).trim(),
                    operands: [],
                    startIndex: i + 1,
                });
                break;
            }
            case ')':
                {
                    const formulaParent = resultStack[resultStack.length - 1];
                    if (lastProcessedIndex !== i - 1) {
                        const substr = formula.slice(formulaParent.startIndex, i);
                        lastProcessedIndex = i;

                        const operand = parseOperand(substr);
                        if (operand === null) {
                            return null; // error
                        }
                        formulaParent.operands.push(operand);
                        formulaParent.startIndex = i + 1;
                    }

                    if (i === formula.length - 1) {
                        // TODO error if too many open stacks at end

                        // if the last character is a closing bracket, we need to pop the last result{
                        return resultStack[0];
                    }

                    // close the previous open bracket into the parents operands
                    const lastResult = resultStack[resultStack.length - 1];
                    const secondLastResult = resultStack[resultStack.length - 2];
                    secondLastResult.operands.push(lastResult);
                    resultStack.length--;
                }
                break;
            case ',': {
                if (lastProcessedIndex !== i - 1) {
                    const formulaParent = resultStack[resultStack.length - 1];
                    lastProcessedIndex = i;
                    const substr = formula.slice(formulaParent.startIndex, i);
                    const operand = parseOperand(substr);
                    if (operand === null) {
                        return null; // error
                    }
                    formulaParent.operands.push(operand);
                    formulaParent.startIndex = i + 1;
                }
            }
        }
    }
    return null;
};

class CellFormula implements IEventEmitter<'destroyed' | 'recalculated'> {
    constructor(
        private rowNode: RowNode,
        private column: AgColumn
    ) {}

    private formulaString: string | null = null;
    private formula: FormulaTree | null = null;
    private value: any = null;

    private setFormulaString(formulaString: string) {
        if (this.formulaString === formulaString) {
            return;
        }

        this.formulaString = formulaString;
        const parsedFormula = parse(formulaString);
        if (parsedFormula) {
            this.formula = parsedFormula;
            // recompute and update parents if value changes
        }
    }

    public forEachDependedOnCell(callback: (cell: Cell) => void) {
        if (!this.formula) {
            return;
        }

        const forEachOperandCell = (operand: FormulaOperand) => {
            if (typeof operand === 'object' && 'rowId' in operand && 'columnId' in operand) {
                callback(operand);
            } else if (Array.isArray(operand)) {
                operand.forEach(forEachOperandCell);
            }
        };

        forEachOperandCell(this.formula);
    }

    private resolveFormula(formula: FormulaTree): any {
        const { operation, operands } = formula;
        if (!this.supportedOperations.has(operation)) {
            return null; // error
        }

        const operationFn = this.supportedOperations.get(operation);
        if (operationFn) {
            return operationFn(
                ...operands.map((operand) => {
                    if (typeof operand !== 'object') {
                        return operand;
                    }
                    if ('rowId' in operand && 'columnId' in operand) {
                        const cellNode = this.beans.rowModel.getRowNode(operand.rowId);
                        const cellColumn = this.beans.colModel.getColById(operand.columnId);
                        if (!cellNode || !cellColumn) {
                            return null; // error
                        }

                        if (this.isFormulaCell(cellColumn, cellNode)) {
                            const formula = getFormula(cellColumn, cellNode);
                            if (!formula) {
                                return null; //error
                            }
                            const parsedFormula = parse(formula);
                            if (parsedFormula) {
                                return this.resolveFormula(parsedFormula);
                            }
                        }
                        return this.beans.valueSvc.getValue(cellColumn, cellNode); // cyclic issues
                    }
                    return this.resolveFormula(operand);
                })
            );
        }
        return null;
    }
}

export class FormulaeService extends BeanStub implements NamedBean {
    beanName = 'formulae' as const;

    private cachedResult = new Map<string, CachedFormulaResult>();

    private supportedOperations = new Map([
        ['SUM', (...args: any[]) => args.reduce((acc, curr) => curr + acc, 0)], // should also support objects, and throw if wrong type provided
        ['DIV', (a: number, b: number) => a / b],
        ['PRODUCT', (...args: any[]) => args.reduce((acc, curr) => acc * curr, 1)],
        ['SUB', (a: number, b: number) => a - b],
        ['MIN', Math.min],
        ['MAX', Math.max],
        ['AVG', (...args: any[]) => args.reduce((acc, curr) => acc + curr, 0) / args.length],
    ]);

    public isFormulaCell(column: AgColumn, node: RowNode): boolean {
        const formula = getFormula(column, node);
        return !!formula;
    }

    public resolveValue(column: AgColumn, node: RowNode): any {
        const formula = getFormula(column, node);
        if (!formula) {
            return null;
        }

        const parsedFormula = parse(formula);
        if (!parsedFormula) {
            return null;
        }

        return this.resolveFormula(parsedFormula);
    }
}
