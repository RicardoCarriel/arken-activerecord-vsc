local Cliente = Class.new("Cliente", "ActiveRecord")

Cliente.hasMany{ name = 'pedidos', record = 'Pedido', foreignKey = 'cliente_id' }

function Cliente:nomeCompleto(separador)
  return self.nome .. (separador or ' ') .. self.sobrenome
end

function Cliente.ativos(params)
  return Cliente.where{ ativo = true }
end

return Cliente
