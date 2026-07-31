import * as stylex from '@stylexjs/stylex';

const styles = stylex.create({
  app: {
    padding: 8,
    color: 'red',
  },
});

// A css prop alongside an explicit `className` (no spread) merges into an
// explicit className that joins the StyleX class with the existing one.
export default function App(props) {
  return (
    <div
      className={[stylex.props(styles.app).className, props.cls]
        .filter(Boolean)
        .join(' ')}
    >
      merge
    </div>
  );
}
