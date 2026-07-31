import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  app: {
    color: 'rgb(10, 20, 30)',
  },
});

// A css prop alongside an explicit `style` (no spread) merges: the rewriter
// emits an explicit className from stylex.props and folds the existing inline
// style in — `style={{ ...stylex.props(...).style, ...<existing> }}`.
export default function App() {
  return (
    <div
      className={stylex.props(styles.app).className}
      style={{ ...stylex.props(styles.app).style, fontSize: '20px' }}
    >
      merge
    </div>
  );
}
