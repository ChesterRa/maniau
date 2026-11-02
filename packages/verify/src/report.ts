/** 「未判定」は、条件を満たすと確認できたことを意味しない。 */
export type VerificationStatus = 'pass' | 'violation' | 'undetermined';

export interface VerificationIssue {
  kind: 'violation' | 'undetermined';
  code: string;
  subject: string;
  detail: string;
}

export interface VerificationReport {
  status: VerificationStatus;
  issues: VerificationIssue[];
}

export class Collector {
  readonly issues: VerificationIssue[] = [];

  violation(code: string, subject: string, detail: string): void {
    this.issues.push({ kind: 'violation', code, subject, detail });
  }

  undetermined(code: string, subject: string, detail: string): void {
    this.issues.push({ kind: 'undetermined', code, subject, detail });
  }

  result(): VerificationReport {
    const status = this.issues.some((issue) => issue.kind === 'violation')
      ? 'violation'
      : this.issues.length > 0
        ? 'undetermined'
        : 'pass';
    return { status, issues: this.issues };
  }
}
