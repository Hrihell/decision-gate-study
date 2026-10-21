const STORAGE_KEY = 'todos';

function load() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
}

function save(todos) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
}

function render(todos) {
  const list = document.getElementById('todo-list');
  list.innerHTML = '';
  todos.forEach((todo, index) => {
    const item = document.createElement('li');
    item.textContent = todo.text;
    item.className = todo.done ? 'done' : '';
    item.addEventListener('click', () => {
      const next = todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t));
      save(next);
      render(next);
    });
    list.appendChild(item);
  });
}

document.getElementById('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.getElementById('new-todo');
  if (input.value.trim() === '') return;
  const next = [...load(), { text: input.value.trim(), done: false }];
  save(next);
  render(next);
  input.value = '';
});

render(load());
