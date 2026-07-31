/** @jsxImportSource @emotion/react */

// A css prop alongside an explicit `className` (no spread) merges into an
// explicit className that joins the StyleX class with the existing one.
export default function App(props) {
  return (
    <div className={props.cls} css={{ padding: 8, color: 'red' }}>
      merge
    </div>
  );
}
