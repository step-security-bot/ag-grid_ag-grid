import { AgColumn, BeanCollection, BeanStub, IEventEmitter, NamedBean, RowNode } from '../main';

// https://plnkr.co/edit/VEnrHRAzelybyacZ?open=main.js
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

const parseOperand = (operand: string): Cell | number | string | boolean => {
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

    // better num parsing probs
    const num = Number(trimmed);
    if (!isNaN(num)) {
        return num;
    }

    const [column, row] = trimmed.split(':'); // cannot allow : in col or row ids
    if (row && column) {
        return {
            rowId: row,
            columnId: column,
        };
    }

    throw new FormulaError('Unsupported operand type ' + operand, '#NAME?');
};

/*
 * Parse a formula string into a tree structure.
 */
const parse = (formula: string): FormulaOperand => {
    if (formula[0] !== '=') {
        throw new FormulaError('Formula must start with =', '#PARSE!');
    }

    const resultStack: (FormulaTree & { startIndex?: number })[] = [];
    let lastRealChar: number | null = null;

    // start at 1 as 0 is always =
    for (let i = 1; i < formula.length; i++) {
        const char = formula[i];
        switch (char) {
            case '(': {
                /**
                 * When we hit an open bracket, add a new item to the result stack.
                 */
                const lastStack = resultStack[resultStack.length - 1];
                const firstIndex = lastStack ? lastStack.startIndex : 1;
                resultStack.push({
                    operation: formula.slice(firstIndex, i).trim(),
                    operands: [],
                    startIndex: i + 1,
                });
                lastRealChar = null;
                break;
            }
            case ')':
                {
                    /**
                     * Closing a bracket means the previous item in the stack is complete.
                     * Need to capture the last substring
                     */
                    const formulaParent = resultStack[resultStack.length - 1];
                    if (lastRealChar !== null) {
                        const substr = formula.slice(formulaParent.startIndex, i);

                        const operand = parseOperand(substr);
                        if (operand === null) {
                            throw new FormulaError('Unexpected closing bracket at ' + i, '#PARSE!');
                        }
                        formulaParent.operands.push(operand);
                        formulaParent.startIndex = i + 1;
                    }

                    // last character to process
                    if (i === formula.length - 1) {
                        // not all stacks are closed
                        if (resultStack.length !== 1) {
                            throw new FormulaError('Open brackets without matching closing.', '#PARSE!');
                        }

                        // if the last character is a closing bracket, we need to pop the last result{
                        return resultStack[0];
                    }

                    if (resultStack.length === 1) {
                        throw new FormulaError('Unexpected closing bracket at ' + i, '#PARSE!');
                    }

                    // close the previous open bracket into the parents operands
                    const lastResult = resultStack[resultStack.length - 1];
                    const secondLastResult = resultStack[resultStack.length - 2];
                    secondLastResult.startIndex = i + 1;
                    secondLastResult.operands.push(lastResult);
                    delete lastResult.startIndex;
                    resultStack.length--;
                    lastRealChar = null;
                }
                break;
            case ',':
                {
                    const formulaParent = resultStack[resultStack.length - 1];
                    if (lastRealChar !== null) {
                        const substr = formula.slice(formulaParent.startIndex, i);
                        const operand = parseOperand(substr);
                        if (operand === null) {
                            throw new FormulaError('Unsupported operand ' + operand, '#PARSE!');
                        }
                        formulaParent.operands.push(operand);
                    }
                    formulaParent.startIndex = i + 1;
                    lastRealChar = null;
                }
                break;
            default: {
                if (lastRealChar === null) {
                    lastRealChar = i;
                }
            }
        }
    }
    if (resultStack.length > 0) {
        throw new FormulaError('Open brackets without matching closing.', '#PARSE!');
    }
    return parseOperand(formula.slice(1));
};
class FormulaError extends Error {
    override name: string = 'FormulaError';
    constructor(
        message: string,
        public type: '#REF!' | '#NAME?' | '#CIRCREF!' | '#PARSE!'
    ) {
        super(message);
    }
}

const resolveFormula = (beans: BeanCollection, formula: FormulaOperand): any => {
    if (typeof formula !== 'object') {
        return formula;
    }

    // cell
    if ('rowId' in formula && 'columnId' in formula) {
        const cellNode = beans.rowModel.getRowNode(formula.rowId);
        const cellColumn = beans.colModel.getColById(formula.columnId);
        if (!cellNode || !cellColumn) {
            throw new FormulaError('Unknown reference to cell', '#REF!');
        }

        return beans.valueSvc.getValue(cellColumn, cellNode);
    }

    // formula tree
    const { operation, operands } = formula;
    const operationFn = beans.formulae?.getFunction(operation);
    if (!operationFn) {
        throw new FormulaError('Unsupported operation ' + operation, '#NAME?');
    }

    const operandValues = operands.map(resolveFormula.bind(null, beans));
    return operationFn(...operandValues);
};

class CellFormula {
    constructor(
        private rowNode: RowNode,
        private column: AgColumn,
        private formulaString: string,
        private readonly formulaService: FormulaeService,
        private readonly beans: BeanCollection
    ) {}

    private formula: FormulaOperand | null = null;
    private value: any = null;
    private valueStale = true;
    private treeStale: boolean = true;
    public error: FormulaError | null = null;

    private setFormulaString(formulaString: string) {
        if (this.formulaString === formulaString) {
            return;
        }

        this.formulaString = formulaString;
        this.valueStale = true;
        this.treeStale = true;
    }

    public onDependencyChanged() {
        this.valueStale = true;
    }

    public getValue() {
        if (!this.valueStale) {
            if (this.error) {
                throw this.error;
            }
            return this.value;
        }

        if (this.treeStale) {
            const parsedFormula = parse(this.formulaString);
            if (parsedFormula) {
                this.formula = parsedFormula;
            }
            this.treeStale = false;
        }

        if (!this.formula) {
            throw new FormulaError('Formula parsing error', '#PARSE!');
        }

        this.valueStale = false;

        try {
            return (this.value = resolveFormula(this.beans, this.formula));
        } catch (e) {
            this.error = e;
            throw e; // catch error to set into this cache. and then throw error up to the next level
        }
    }
}

export class FormulaeService extends BeanStub implements NamedBean {
    beanName = 'formulae' as const;

    private cachedResult = new WeakMap<RowNode, WeakMap<AgColumn, CellFormula>>();

    private supportedOperations = new Map([
        ['SUM', (...args: any[]) => args.reduce((acc, curr) => curr + acc, 0)], // should also support objects, and throw if wrong type provided
        ['DIV', (a: number, b: number) => a / b],
        ['PRODUCT', (...args: any[]) => args.reduce((acc, curr) => acc * curr, 1)],
        ['SUB', (a: number, b: number) => a - b],
        ['MIN', Math.min],
        ['MAX', Math.max],
        ['AVG', (...args: any[]) => args.reduce((acc, curr) => acc + curr, 0) / args.length],
    ]);

    public postConstruct(): void {
        const customFuncs = this.gos.get('formulaFuncs');
        if (!customFuncs) {
            return;
        }
        Object.keys(customFuncs).forEach((name) => {
            this.supportedOperations.set(name, customFuncs[name]!);
        });
    }

    // temp, when value changes, clear all cached results
    public reset() {
        // clear old result, any way to do more granularly?
        this.cachedResult = new WeakMap<RowNode, WeakMap<AgColumn, CellFormula>>();
        this.beans.rowRenderer.refreshCells();
    }

    public isFormulaCell(column: AgColumn, node: RowNode): boolean {
        const formula = getFormula(column, node);
        return !!formula;
    }

    public getFormulaError(column: AgColumn, node: RowNode): FormulaError | null {
        const rowFormulas = this.cachedResult.get(node);
        if (!rowFormulas) {
            return null;
        }
        const cellFormula = rowFormulas.get(column);
        if (!cellFormula) {
            return null;
        }
        return cellFormula.error;
    }

    public getFunction(name: string) {
        return this.supportedOperations.get(name);
    }

    private circularRefSet: WeakSet<CellFormula> | null = null;
    public resolveValue(column: AgColumn, node: RowNode): any {
        const formulaString = getFormula(column, node);
        if (!formulaString) {
            return null;
        }

        let rowFormulas = this.cachedResult.get(node);
        if (!rowFormulas) {
            rowFormulas = new Map();
            this.cachedResult.set(node, rowFormulas);
        }

        let cellFormula = rowFormulas.get(column);
        if (!cellFormula) {
            cellFormula = new CellFormula(node, column, formulaString, this, this.beans);
            rowFormulas.set(column, cellFormula);
        }

        // if no circular ref checker, create one
        if (!this.circularRefSet) {
            this.circularRefSet = new WeakSet([cellFormula]);
            try {
                const value = cellFormula.getValue();
                this.circularRefSet = null;
                return value;
            } catch (e) {
                this.circularRefSet = null;
                cellFormula.error = e;
                return e.type;
            }
        }

        if (this.circularRefSet.has(cellFormula)) {
            cellFormula.error = new FormulaError('Circular reference', '#CIRCREF!');
            throw cellFormula.error;
        }
        this.circularRefSet.add(cellFormula);
        const value = cellFormula.getValue();
        this.circularRefSet.delete(cellFormula);
        return value;
    }
}
