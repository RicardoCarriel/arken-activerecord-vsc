local Pedido = Class.new("Pedido", "ActiveRecord")

Pedido.belongsTo{ name = 'cliente', record = 'Cliente', foreignKey = 'cliente_id' }
Pedido.hasMany{ name = 'itens', record = 'Pedido.Item', foreignKey = 'pedido_id' }

function Pedido:total()
  return 0
end

Pedido.abertos = function(clienteId)
  return Pedido.where{ cliente_id = clienteId, status = 'aberto' }
end

return Pedido
