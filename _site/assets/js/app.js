(function($) {

	var cluster = {
		_info: {
			host: '',
			name: 'Not Connected',
			status: 'red',
			version: {
				major: null,
				minor: null,
				patch: null
			},
			master_node: null
		},
		_is_refreshing: false,
		_last_update: null,
		_refresh_interval: 5000,
		_interval_id: null,

		init: function() {
			var self = this;

			// Set default configs
			if ( '/_plugin/whatson' == window.location.pathname.substr(0,16) ) {
				// Running as ES site plugin
				self._info.host = window.location.protocol + '//' + window.location.host;
			} else {
				// Running elsewhere
				self._info.host = '';
			}
			$( '#navbar-clusterconfig-host' ).val( self._info.host );
			self._refresh_interval = 5000;
			$( '#navbar-clusterconfig-refresh' ).val( self._refresh_interval / 1000 );

			self.render();
			nodes.init();
			indices.init();
			segments.init();

			// Get data
			self.refresh();

			// Actions
			$( '#navbar-clustername-statusicon' ).on( 'click', function() {
				var element = $( this );
				var config_panel = $( '#navbar-clusterconfig' );

				if ( element.hasClass( 'configure' ) ) {
					config_panel.slideUp( 'fast' );
					element.removeClass( 'configure' );
				} else {
					config_panel.slideDown( 'fast', function() {
						$( '#navbar-clusterconfig-host' ).focus();
					} );
					element.addClass( 'configure' );
				}
			} );

			$( '#navbar-clusterconfig-update' ).on( 'submit', function(event) {
				event.preventDefault();

				var need_refresh = false;
				var host = $( '#navbar-clusterconfig-host' ).val();
				if ( '' != host ) {
					host = host.replace(/\/$/g, "");
					if ( null == host.match(/^https?:\/\//) )
						host = 'http://' + host;
					if ( null == host.match(/:[0-9]*$/) )
						host += ':9200';

					$( '#navbar-clusterconfig-host' ).val( host );
				}
				if ( self._info.host != host ) {
					self._info.host = host;
					need_refresh = true;
				}

				var refresh = $( '#navbar-clusterconfig-refresh' ).val() * 1000;
				if ( self._refresh_interval != refresh ) {
					self._refresh_interval = refresh;
					need_refresh = true;
				}

				if ( need_refresh ) {
					self.refresh();
				}

				$( '#navbar-clustername-statusicon' ).removeClass( 'configure' );
				$( '#navbar-clusterconfig' ).slideUp( 'fast' );
			} );
		},

		refresh: function() {
			var self = this;

			if ( null != self._interval_id ) {
				window.clearInterval( self._interval_id );
			}

			nodes.reset();
			indices.reset();
			self._is_refreshing = false;

			if ( '' == self._info.host ) {
				self.set_info( {
					'status': 'red',
					'name': 'No Host Set'
				} );
				self.render();

				$( '#navbar-clustername-statusicon' ).addClass( 'configure' );
				$( '#navbar-clusterconfig' ).slideDown( 'fast', function() {
					$( '#navbar-clusterconfig-host' ).focus();
				} );

				return;
			}

			self._interval_id = window.setInterval( function() {
				self.sync_data();
			}, self._refresh_interval );

			self.sync_data();
		},

		set_info: function( info ) {
			var self = this;
			self._info = _.defaults( info, self._info );
			return self;
		},

		get_info: function() {
			var self = this;
			return self._info;
		},

		sync_data: function() {
			var self = this;

			if ( self._is_refreshing )
				return;

			self._is_refreshing = true;

			$.when(
				$.getJSON( cluster.get_info().host + '/' ),
				$.getJSON( cluster.get_info().host + '/_cluster/health' )
			)
			.done(function( result_root, result_health ) {
				// Get version
				self._info.version = _.object(
					['major','minor','patch'],
					result_root[0].version.number.split('.')
				);

				switch( result_health[0].status ) {
					case 'green':
						self.set_info( {
							'status': 'green',
							'name': result_health[0].cluster_name
						} );
						break;
					case 'yellow':
						self.set_info( {
							'status': 'yellow',
							'name': result_health[0].cluster_name
						} );
						break;
					case 'red':
						self.set_info( {
							'status': 'red',
							'name': result_health[0].cluster_name
						} );
						break;
					default:
						self.set_info( {
							'status': 'red',
							'name': 'Invalid Response'
						} );
						break;
				}
				self._is_refreshing = false;
				self._last_update = new Date();
				self.render();

				nodes.sync_data();
				indices.sync_data();
			})
			.fail(function() {
				self.set_info( {
					'status': 'red',
					'name': 'Not Connected'
				} );
				self._is_refreshing = false;
				self.render();
			});
		},

		render: function() {
			var self = this;

			if ( self._is_refreshing )
				return;

			$( '#navbar-clustername-name' )
				.text( self._info.name );
			$( '#navbar-clustername' )
				.removeClass( 'status-green status-yellow status-red' )
				.addClass( 'status-' + self._info.status )
		}
	};

	var nodes = {
		_svg: null,
		_svg_padding_x: 40,
		_svg_padding_y: 20,
		_svg_width: 860,
		_svg_height: 260,
		_nodes: {},
		_node_shards: {},
		_selected: null,
		_hover: null,
		_is_refreshing: false,
		_last_update: null,
		_pause: false,

		init: function() {
			var self = this;

			self._svg = d3
				.select( '#nodes-svg' )
				.attr( 'width', self._svg_width + self._svg_padding_x * 2 )
				.attr( 'height', self._svg_height + self._svg_padding_y * 2 )
				.attr( 'viewBox', "0 0 " + (self._svg_width + self._svg_padding_x * 2) + " " + (self._svg_height + self._svg_padding_y * 2) )
				.attr( 'preserveAspectRatio', "xMidYMid" )
				.append( 'g' );

			self.resize();
			$(window).on("resize", function() {
				self.resize();
			} );

			$( '#nodes-filter' ).keyup( function() {
				self.render();
			} );

			// Set hover events
			$( document ).on( 'mouseover', '#nodes-svg .node', function() {
				var node = $( this ).data( 'node' );
				self._hover = node.id;
				self._write_out_info_cells(
					node,
					$( '#nodes-info-footer tbody.inspect tr' )
				);
			} );

			$( '#nodes-svg-container' ).on( 'mouseenter', function() {
				$( this ).addClass( 'hover' );
				$( '#nodes' ).addClass( 'hover' );
			} );

			$( '#nodes-svg-container' ).on( 'mouseleave', function() {
				$( this ).removeClass( 'hover' );
				$( '#nodes' ).removeClass( 'hover' );
			} );

			$( '#nodes-svg' ).on( 'mouseover', '.disk', function( event ) {
				var element = $( this )

				self._pause = true;

				if ( !element.data( 'powertip-init' ) ) {
					element.powerTip( {
						manual: true,
						placement: 'e',
						smartPlacement: true
					} );
					element.data( 'powertip-init', true );
				}

				$.powerTip.show( this, event );
			} );
			$( '#nodes-svg' ).on( 'mouseleave', '.disk', function( event ) {
				$.powerTip.hide( this );
				self._pause = false;
			} );
		},

		reset: function() {
			var self = this;
			self._selected = null;
			self._hover = null;
			self._is_refreshing = false;
		},

		_write_out_info_cells: function( node, tr ) {
			if ( null == node )
				return;

			tr.children( '.col-name' ).text( node.name );
			tr.children( '.col-ver' ).text( node.version );
			tr.children( '.col-total' ).text( d3.format( '.3s' )( node.size.disk ) + 'B' );
			tr.children( '.col-free' ).text( d3.format( '.3s' )( node.size.free ) + 'B' );
			tr.children( '.col-index' ).text( d3.format( '.3s' )( node.size.index ) + 'B' );
			tr.children( '.col-docs' ).text( d3.format( '.3s' )( node.docs.count ) );
			tr.children( '.col-ratio' ).text( d3.format( '.2f' )( node.docs.deleted_ratio * 100 ) + '%' );
		},

		get_node: function( node_id ) {
			var self = this;

			if ( undefined == self._nodes[ node_id ] )
				return false;
			else
				return self._nodes[ node_id ]
		},

		resize: function() {
			var self = this,
				aspect = (self._svg_width + self._svg_padding_x * 2) / (self._svg_height + self._svg_padding_y * 2),
				chart = $("#nodes-svg"),
				targetWidth = chart.parent().width();
			chart.attr("width", targetWidth);
			chart.attr("height", targetWidth / aspect);
		},

		sync_data: function() {
			var self = this;

			if ( self._is_refreshing || self._pause )
				return;

			self._is_refreshing = true;

			var endpoints = [
				cluster.get_info().host + '/_nodes/_all/attributes',
				cluster.get_info().host + '/_nodes/stats/indices,fs',
				cluster.get_info().host + '/_cluster/state/master_node'
			];

			if ( 0 == cluster.get_info().version.major ) {
				endpoints = [
					cluster.get_info().host + '/_nodes',
					cluster.get_info().host + '/_nodes/stats?fs=true',
					cluster.get_info().host + '/_cluster/state?filter_blocks=true&filter_routing_table=true&filter_metadata=true'
				];
			}

			$.when(
				$.getJSON( endpoints[0] ),
				$.getJSON( endpoints[1] ),
				$.getJSON( endpoints[2] )
			)
			.done(function( result_nodes, result_nodes_stats, result_cluster_state ) {

				// Set Master Node ID
				cluster.set_info( {
					'master_node': result_cluster_state[0].master_node
				} );

				// Set data
				_.each( result_nodes[0].nodes, function( node, node_id ) {
					self._nodes[ node_id ] = _.defaults( node, self._nodes[ node_id ] );
				} );

				_.each( result_nodes_stats[0].nodes, function( node, node_id ) {
					var data = _.pick(
						node,
						[ 'name', 'transport_address', 'host', 'attributes' ]
					);

					if ( 0 == cluster.get_info().version.major )
						data.host = node.hostname;

					data.size = {
						'disk': node.fs.total.total_in_bytes,
						'free': node.fs.total.free_in_bytes,
						'system': node.fs.total.total_in_bytes - node.fs.total.free_in_bytes - node.indices.store.size_in_bytes,
						'index': node.indices.store.size_in_bytes
					};

					data.docs = {
						'count': node.indices.docs.count,
						'deleted': node.indices.docs.deleted,
						'deleted_ratio': get_deleted_ratio( node.indices.docs.count, node.indices.docs.deleted )
					}

					// Set metadata
					data.id = node_id;
					data.sortkey = data.host.split('.').reverse().join('.') + ' ' + data.name;

					self._nodes[ node_id ] = _.defaults( data, self._nodes[ node_id ] );
				} );

				// Remove non-existant nodes
				var dead_nodes = _.difference(
					_.keys( self._nodes ),
					_.union(
						_.keys( result_nodes[0].nodes ),
						_.keys( result_nodes_stats[0].nodes )
					)
				);
				self._nodes = _.omit( self._nodes, dead_nodes );

				self._is_refreshing = false;
				self._last_update = new Date();

				self.render();
			})
			.fail(function() {
				self._is_refreshing = false;
			});
		},

		set_shards: function( node_shards ) {
			var self = this;
			self._node_shards = node_shards;
			self.render();
		},

		render: function() {
			var self = this;

			if ( self._is_refreshing || self._pause )
				return;

			self._update_cluster_totals();

			if ( null != self._selected ) {
				self._write_out_info_cells(
					self._nodes[ self._selected ],
					$( '#nodes-info-footer tbody.monitor tr' )
				);
				self._highlighted_shards_for_node( self._selected );
			}

			if ( null != self._hover ) {
				self._write_out_info_cells(
					self._nodes[ self._hover ],
					$( '#nodes-info-footer tbody.inspect tr' )
				);
			}

			var filtered_nodes = self._get_filtered_nodes(),
				node_x = d3
					.scale
					.linear()
					.range( [ 0, self._svg_width ] )
					.domain( [ 0, filtered_nodes.nodes.length ] ),
				node_h = d3
					.scale
					.linear()
					.range( [ self._svg_height, 0 ] )
					.domain( [ 0, d3.max( filtered_nodes.nodes, function(d) { return d.size.disk; } ) ] ),
				node_axis = d3
					.svg
					.axis()
					.scale( node_h )
					.orient( "left" )
					.ticks( 5 )
					.tickFormat( function(d) { return d3.format( '.2s' )( d ) + 'B' } ),
				ratio_y = d3
					.scale
					.linear()
					.range( [ self._svg_height, 0 ] )
					.domain( [ 0, 0.5 ] ),
				ratio_line = d3
					.svg
					.line()
					.x( function(d, i) { return node_x( i + 0.5 ); } )
					.y( function(d) { return ratio_y( d.docs.deleted_ratio ); } ),
				ratio_axis = d3
					.svg
					.axis()
					.scale( ratio_y )
					.orient( "right" )
					.ticks( 5 )
					.tickFormat( function(d) { return Math.round( d * 100 ) + '%' } ),
				click_event = function( element, d ) {
					var e = d3.event,
						g = element.parentNode,
						isSelected = d3.select( g ).classed( "selected" );

					// Unselect everything else
					d3.selectAll( 'g.selected' ).classed( "selected", false );
					// Toggle select
					d3.select( g ).classed( "selected", !isSelected );

					if ( !isSelected ) {
						$( '#nodes-svg-container' ).addClass( 'selected' );
						$( '#nodes' ).addClass( 'selected' );
						self._selected = d.id;
						self._write_out_info_cells(
							self._nodes[ d.id ],
							$( '#nodes-info-footer tbody.monitor tr' )
						);
						self._highlighted_shards_for_node( d.id );
					} else {
						$( '#nodes-svg-container' ).removeClass( 'selected' );
						$( '#nodes' ).removeClass( 'selected' );
						self._selected = null;
						self._write_out_info_cells(
							null,
							$( '#nodes-info-footer tbody.monitor tr' )
						);

						self._highlighted_shards_for_node( null );
					}
				};


			$( '#nodes h2 small' ).text(
				'(' +
				filtered_nodes.counts.filtered +
				'/' +
				filtered_nodes.counts.data +
				' Data, ' +
				filtered_nodes.counts.total +
				' Total)'
			);

			self._svg
				.selectAll( 'g' )
				.remove();

			var node_g = self._svg
				.selectAll( '.node' )
				.data( filtered_nodes.nodes, function(d) { return d.id; } )
				.enter()
				.append( 'g' )
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")")
				.attr( 'data-node', function(d) { return JSON.stringify( d ); } )
				.attr( 'class', function(d) {
					var class_names = 'node';
					if ( undefined != self._node_shards[ d.id ] ) {
						if ( self._node_shards[ d.id ].UNASSIGNED.length )
							class_names += ' shard-state-unassigned'; // unpossible
						if ( self._node_shards[ d.id ].INITIALIZING.length )
							class_names += ' shard-state-initializing';
						if ( self._node_shards[ d.id ].RELOCATING.length )
							class_names += ' shard-state-relocating';
					}
					if ( self._selected == d.id ) {
						class_names += ' selected';
					}
					return class_names
				} )
				.attr( 'id', function(d) { return 'node-' + d.id; } );

			// Index size
			node_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return node_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return node_h( d.size.index );
				}  )
				.attr( "width", node_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return self._svg_height - node_h( d.size.index );
				} )
				.classed( { 'index': true } );

			// System size
			node_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return node_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return node_h( d.size.index + d.size.system );
				}  )
				.attr( "width", node_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return self._svg_height - node_h( d.size.system );
				} )
				.classed( { 'system': true } );

			// Free disk
			node_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return node_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return node_h( d.size.index + d.size.system + d.size.free );
				}  )
				.attr( "width", node_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return self._svg_height - node_h( d.size.free );
				} )
				.classed( { 'free': true } );

			// Disk size, a.k.a. overlay on the entire node column
			node_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return node_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return node_h( d.size.disk );
				}  )
				.attr( "width", node_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return self._svg_height;
				} )
				.attr( 'data-powertip', function(d) {
					var tooltip = '<strong>' + d.name + '</strong>';
					tooltip += d3.format( '.3s' )( d.size.index ) + 'B Index';
					tooltip += '<br>' + d3.format( '.2f' )( d.docs.deleted_ratio * 100 ) + '% Deleted';

					if ( undefined != self._node_shards[ d.id ] ) {
						tooltip += '<br>' + self._node_shards[ d.id ].STARTED.length + ' Shards';
						if ( self._node_shards[ d.id ].INITIALIZING.length > 0 ) {
							tooltip += ', ' + self._node_shards[ d.id ].INITIALIZING.length + ' Initializing';
						}
						if ( self._node_shards[ d.id ].RELOCATING.length > 0 ) {
							tooltip += ', ' + self._node_shards[ d.id ].RELOCATING.length + ' Relocating Away';
						}
					}

					return tooltip;
				} )
				.classed( { 'disk': true } )
				.on( "click", function( d ) {
					click_event( this, d );
				} );

			self._svg
				.append("g")
				.attr("class", "y axis")
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")")
				.call(node_axis)
				.selectAll("text")
				.attr("dy", "1em")
				.attr("transform", "rotate(45)");

			// Delete ratio
			var ratio_g = self._svg
				.append( 'g' )
				.attr( 'class', 'node_ratio' )
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")");

			ratio_g
				.append("path")
				.datum(filtered_nodes.nodes)
				.attr("class", "line")
				.attr("d", ratio_line);

			ratio_g
				.selectAll('circle')
				.data(filtered_nodes.nodes)
				.enter()
				.append('circle')
				.attr("cx", function(d, i) { return node_x( i + 0.5 ); } )
				.attr("cy", function(d) { return ratio_y( d.docs.deleted_ratio ); } )
				.attr("r", 1.5)
				.attr("class", "line-point");

			self._svg
				.append("g")
				.attr("class", "y axis ratio")
				.attr("transform", "translate("+(self._svg_width+self._svg_padding_x)+","+self._svg_padding_y+")")
				.call(ratio_axis);
		},

		_highlighted_shards_for_node: function( node_id ) {
			var self = this,
				node_shards = self._node_shards,
				highlight_shards = {};

			if ( null == node_id || undefined == node_shards[ node_id ] ) {
				indices.set_highlight_shards( {} );
				return;
			}

			_.each(
				_.union(
					node_shards[ node_id ].INITIALIZING,
					node_shards[ node_id ].RELOCATING,
					node_shards[ node_id ].STARTED
				),
				function( shard_instance ) {
					if ( undefined == highlight_shards[ shard_instance.index ] ) {
						highlight_shards[ shard_instance.index ] = {};
					}
					if ( undefined == highlight_shards[ shard_instance.index ][ shard_instance.shard ] ) {
						highlight_shards[ shard_instance.index ][ shard_instance.shard ] = 'R';
					}
					if ( shard_instance.primary ) {
						highlight_shards[ shard_instance.index ][ shard_instance.shard ] = 'P';
					}
				}
			);

			indices.set_highlight_shards( highlight_shards );
		},

		_get_filtered_nodes: function() {
			var self = this;
			var counts = {
				'total': _.keys( self._nodes ).length,
				'data': 0,
				'filtered': 0,
			};

			// Get only data nodes
			var data_nodes = _.filter( self._nodes, function( node ) {
				if ( undefined == node.attributes )
					return true;
				return ( "false" != node.attributes.data );
			} );
			counts.data = data_nodes.length;

			// Apply filter from UI
			var filter = $( '#nodes-filter' ).val();
			if ( '' != filter ) {
				var regex = new RegExp( filter, 'i' );
				data_nodes = _.filter( data_nodes, function( node ) {
					return null != JSON.stringify( node ).match( regex );
				} );
			}
			counts.filtered = data_nodes.length;

			// Sort nodes
			data_nodes.sort( function( a, b ) {
				return alphanum( a.sortkey, b.sortkey );
			} );

			return {
				'counts': counts,
				'nodes': data_nodes
			};
		},

		_update_cluster_totals: function() {
			var self = this,
				cluster_version = '',
				cluster_version_mixed = false,
				cluster_totals = {
					'disk': 0,
					'free': 0,
					'index': 0,
					'docs': 0,
					'deleted': 0
				};

			_.each( self._nodes, function( node ) {
				if ( '' == cluster_version )
					cluster_version = node.version;
				if ( cluster_version != node.version )
					cluster_version_mixed = true;

				cluster_totals.disk += node.size.disk;
				cluster_totals.free += node.size.free;
				cluster_totals.index += node.size.index;
				cluster_totals.docs += node.docs.count;
				cluster_totals.deleted += node.docs.deleted;
			} );

			var tr = $( '#nodes-info-footer tbody.totals tr' );
			tr.children( '.col-name' ).html(
				'<em>Cluster &mdash; ' + self._nodes[ cluster.get_info().master_node ].name + '</em>'
			);
			if ( cluster_version_mixed )
				tr.children( '.col-ver' ).html( '<em>Mixed!</em>' );
			else
				tr.children( '.col-ver' ).text( cluster_version );
			tr.children( '.col-total' ).text( d3.format( '.3s' )( cluster_totals.disk ) + 'B' );
			tr.children( '.col-free' ).text( d3.format( '.3s' )( cluster_totals.free ) + 'B' );
			tr.children( '.col-index' ).text( d3.format( '.3s' )( cluster_totals.index ) + 'B' );
			tr.children( '.col-docs' ).text( d3.format( '.3s' )( cluster_totals.docs ) );
			tr.children( '.col-ratio' ).text( d3.format( '.2f' )( get_deleted_ratio( cluster_totals.docs, cluster_totals.deleted ) * 100 ) + '%' );
		}
	};

	var indices = {
		_svg: null,
		_svg_padding_x: 40,
		_svg_padding_y: 20,
		_svg_width: 860,
		_svg_height: 260,
		_indices: {},
		_is_refreshing: false,
		_last_update: null,
		_selected: {
			index: null,
			shard: null
		},
		_hover: {
			index: null,
			shard: null
		},
		_highlight_shards: {},
		_pause: false,

		init: function() {
			var self = this;

			self._svg = d3
				.select( '#indices-svg' )
				.attr( 'width', self._svg_width + self._svg_padding_x * 2 )
				.attr( 'height', self._svg_height + self._svg_padding_y * 2 )
				.attr( 'viewBox', "0 0 " + (self._svg_width + self._svg_padding_x * 2) + " " + (self._svg_height + self._svg_padding_y * 2) )
				.attr( 'preserveAspectRatio', "xMidYMid" )
				.append( 'g' );

			self.resize();
			$(window).on("resize", function() {
				self.resize();
			} );

			$( '#indices-filter' ).keyup( function() {
				self.render();
			} );

			// Set hover events
			$( document ).on( 'mouseover', '#indices-svg .index', function() {
				var index = $( this ).data( 'index' );
				self._hover = {
					index: index.id,
					shard: null
				};
				self._write_out_info_cells(
					index,
					null,
					$( '#indices-info-footer tbody.inspect tr.index' ),
					$( '#indices-info-footer tbody.inspect tr.shard' )
				);
			} );

			$( document ).on( 'mouseover', '#indices-svg .shard', function() {
				var index = $( this ).data( 'index' );
				var shard = $( this ).data( 'shard' );
				self._hover = {
					index: index.id,
					shard: shard.shard_num
				};
				self._write_out_info_cells(
					index,
					shard,
					$( '#indices-info-footer tbody.inspect tr.index' ),
					$( '#indices-info-footer tbody.inspect tr.shard' )
				);
			} );

			$( document ).on( 'mouseleave', '#indices-svg .index, #indices-svg .shard', function() {
				self._hover = {
					index: null,
					shard: null
				};
			} );

			$( document ).on( 'click', '#indices-svg .index', function() {
				self._write_out_info_cells(
					$( this ).data( 'index' ),
					null,
					$( '#indices-info-footer tbody.monitor tr.index' ),
					$( '#indices-info-footer tbody.monitor tr.shard' )
				);
			} );

			$( document ).on( 'click', '#indices-svg .shard', function() {
				self._write_out_info_cells(
					$( this ).data( 'index' ),
					$( this ).data( 'shard' ),
					$( '#indices-info-footer tbody.monitor tr.index' ),
					$( '#indices-info-footer tbody.monitor tr.shard' )
				);
			} );

			$( '#indices-svg-container' ).on( 'mouseenter', function() {
				$( this ).addClass( 'hover' );
				$( '#indices' ).addClass( 'hover' );
			} );

			$( '#indices-svg-container' ).on( 'mouseleave', function() {
				$( this ).removeClass( 'hover' );
				$( '#indices' ).removeClass( 'hover' );

				self._write_out_info_cells(
					null,
					null,
					$( '#indices-info-footer tbody.inspect tr.index' ),
					$( '#indices-info-footer tbody.inspect tr.shard' )
				);
			} );

			$( '#indices-svg' ).on( 'mouseover', '.hover-target, .shard rect', function( event ) {
				var element = $( this )

				self._pause = true;

				if ( !element.data( 'powertip-init' ) ) {
					var placement = ( 'hover-target' == element.attr( 'class' ) ? 's' : 'n' );

					element.powerTip( {
						manual: true,
						placement: placement,
						smartPlacement: true
					} );
					element.data( 'powertip-init', true );
				}

				$.powerTip.show( this, event );
			} );
			$( '#indices-svg' ).on( 'mouseleave', '.hover-target, .shard rect', function( event ) {
				$.powerTip.hide( this );
				self._pause = false;
			} );
		},

		reset: function() {
			var self = this;
			self._selected = {
				index: null,
				shard: null
			};
			self._hover = {
				index: null,
				shard: null
			};
			self._highlight_shards = {};
			self._is_refreshing = false;
		},

		_write_out_info_cells: function( index, shard, tr_index, tr_shard ) {

			if ( null == index ) {
				tr_index.children( '.col-name' ).html( '<strong>Index:</strong> &mdash;' );
				tr_index.children( '.col-status' ).html( '&mdash;' );
				tr_index.children( '.col-size-primary' ).html( '&mdash;' );
				tr_index.children( '.col-size-total' ).html( '&mdash;' );
				tr_index.children( '.col-docs' ).html( '&mdash;' );
				tr_index.children( '.col-ratio' ).html( '&mdash;' );
			} else {
				tr_index.children( '.col-name' ).html( '<strong>Index:</strong> ' + index.id );
				tr_index.children( '.col-status' ).text( index.status );
				tr_index.children( '.col-size-primary' ).text( d3.format( '.3s' )( index.size.primary ) + 'B' );
				tr_index.children( '.col-size-total' ).text( d3.format( '.3s' )( index.size.total ) + 'B' );
				tr_index.children( '.col-docs' ).text( d3.format( '.3s' )( index.docs.count ) );
				tr_index.children( '.col-ratio' ).text( d3.format( '.2f' )( index.docs.deleted_ratio * 100 ) + '%' );
			}

			if ( null == shard ) {
				tr_shard.children( '.col-name' ).html( '<strong>Shard:</strong> &mdash;' );
				tr_shard.children( '.col-status' ).html( '&mdash;' );
				tr_shard.children( '.col-size-primary' ).html( '&mdash;' );
				tr_shard.children( '.col-size-total' ).html( '&mdash;' );
				tr_shard.children( '.col-docs' ).html( '&mdash;' );
				tr_shard.children( '.col-ratio' ).html( '&mdash;' );
			} else {
				var shard_status = shard.active_shards + ' active';
				if ( !( 'green' == shard.status && 0 == shard.relocating_shards ) ) {
					var max_recovery_time = {
							'in_millis': 0,
							'string': ''
						},
						shard_states = {
							'UNASSIGNED': 0,
							'INITIALIZING': 0,
							'RELOCATING': 0,
							'STARTED': 0
						};

					_.each( shard.shards, function( shard ) {
						shard_states[ shard.state ]++;
						if ( undefined != shard.recovery_time && max_recovery_time.in_millis < shard.recovery_time.in_millis ) {
							max_recovery_time = shard.recovery_time;
						}
					} );

					if ( shard_states[ 'UNASSIGNED' ] > 0 ) {
						shard_status = shard_states[ 'UNASSIGNED' ] + ' unassigned';
					} else if ( shard_states[ 'INITIALIZING' ] > 0 ) {
						shard_status = shard_states[ 'INITIALIZING' ] + ' initializing';
					} else if ( shard_states[ 'RELOCATING' ] > 0 ) {
						shard_status = shard_states[ 'RELOCATING' ] + ' relocating';
					} else {
						shard_status = 'unknown error';
					}

					if ( max_recovery_time.in_millis > 0 ) {
						shard_status += ' (' + max_recovery_time.string + ' elapsed)';
					}
				}

				tr_shard.children( '.col-name' ).html( '<strong>Shard:</strong> ' + shard.shard_num );
				tr_shard.children( '.col-status' ).text( shard_status );
				tr_shard.children( '.col-size-primary' ).text( d3.format( '.3s' )( shard.size.primary ) + 'B' );
				tr_shard.children( '.col-size-total' ).text( d3.format( '.3s' )( shard.size.total ) + 'B' );
				tr_shard.children( '.col-docs' ).text( d3.format( '.3s' )( shard.docs.count ) );
				tr_shard.children( '.col-ratio' ).text( d3.format( '.2f' )( shard.docs.deleted_ratio * 100 ) + '%' );
			}
		},

		resize: function() {
			var self = this,
				aspect = (self._svg_width + self._svg_padding_x * 2) / (self._svg_height + self._svg_padding_y * 2),
				chart = $("#indices-svg"),
				targetWidth = chart.parent().width();
			chart.attr("width", targetWidth);
			chart.attr("height", targetWidth / aspect);
		},

		sync_data: function() {
			var self = this;

			if ( self._is_refreshing || self._pause )
				return;

			self._is_refreshing = true;

			var endpoints = [
				cluster.get_info().host + '/_cluster/health?level=shards',
				cluster.get_info().host + '/_cluster/state/routing_table',
				cluster.get_info().host + '/_status?recovery=true'
			];

			if ( 0 == cluster.get_info().version.major ) {
				endpoints = [
					cluster.get_info().host + '/_cluster/health?level=shards',
					cluster.get_info().host + '/_cluster/state?filter_blocks=true&filter_nodes=true&filter_metadata=true',
					cluster.get_info().host + '/_status?recovery=true'
				];
			}

			$.when(
				$.getJSON( endpoints[0] ),
				$.getJSON( endpoints[1] ),
				$.getJSON( endpoints[2] )
			)
			.done(function( result_health, result_cluster_state, result_status ) {

				_.each( result_health[0].indices, function( index, index_name ) {
					var data = index;
					data.size = {
						'primary': 0,
						'total': 0
					};
					data.docs = {
						'count': 0,
						'deleted': 0,
						'deleted_ratio': 0
					};
					self._indices[ index_name ] = _.defaults( data, self._indices[ index_name ] );

					// Set metadata
					self._indices[ index_name ].id = index_name;
					self._indices[ index_name ].sortkey = index_name;
				} );

				_.each( result_cluster_state[0].routing_table.indices, function( index, index_name ) {
					_.each( index.shards, function( shards, shard_num ) {
						self._indices[ index_name ][ 'shards' ][ shard_num ] = _.defaults(
							{
								'shard_num': shard_num,
								'shards': shards,
								'size': {
									'primary': 0,
									'total': 0
								},
								'docs': {
									'count': 0,
									'deleted': 0,
									'deleted_ratio': 0
								}
							},
							self._indices[ index_name ][ 'shards' ][ shard_num ]
						);
					} );
				} );

				_.each( result_status[0].indices, function( index, index_name ) {
					self._indices[ index_name ] = _.defaults(
						{
							'size': {
								'primary': index.index.primary_size_in_bytes,
								'total': index.index.size_in_bytes
							},
							'docs': {
								'count': index.docs.num_docs,
								'deleted': index.docs.deleted_docs,
								'deleted_ratio': get_deleted_ratio( index.docs.num_docs, index.docs.deleted_docs )
							}
						},
						self._indices[ index_name ]
					);

					_.each( index.shards, function( shards, shard_num ) {
						var data = {
							'shard_num': shard_num,
							'size': {
								'primary': 0,
								'total': 0
							},
							'docs': {
								'count': 0,
								'deleted': 0,
								'deleted_ratio': 0
							}
						};

						_.each( shards, function( shard ) {
							data.size.total += shard.index.size_in_bytes;

							// Fill in shard info
							if ( shard.routing.primary ) {
								data.size.primary = shard.index.size_in_bytes;
								data.docs = {
									'count': shard.docs.num_docs,
									'deleted': shard.docs.deleted_docs,
									'deleted_ratio': get_deleted_ratio( shard.docs.num_docs, shard.docs.deleted_docs )
								};
							}

							// Fill in recovery info if we are recovering
							if ( "RECOVERING" == shard.state ) {
								var found_shard_num = null;
								_.each( self._indices[ index_name ][ 'shards' ][ shard_num ][ 'shards' ], function( test_shard, shard_num ) {
									if ( test_shard.node == shard.routing.node )
										found_shard_num = shard_num;
								} );

								if ( null !== found_shard_num ) {
									self._indices[ index_name ][ 'shards' ][ shard_num ][ 'shards' ][ found_shard_num ][ 'recovery_time' ] = {
										'in_millis': shard.peer_recovery.time_in_millis,
										'string': shard.peer_recovery.time
									};
								}
							}
						} );

						self._indices[ index_name ][ 'shards' ][ shard_num ] = _.defaults(
							data,
							self._indices[ index_name ][ 'shards' ][ shard_num ]
						);
					} );
				} );

				// Remove non-existant nodes
				var dead_indices = _.difference(
					_.keys( self._indices ),
					_.keys( result_health[0].indices )
				);
				self._indices = _.omit( self._indices, dead_indices );

				self._is_refreshing = false;
				self._last_update = new Date();

				self._notify_nodes_of_shards();
				self.render();
			})
			.fail(function() {
				self._is_refreshing = false;
			});
		},

		render: function() {
			var self = this;

			if ( self._is_refreshing || self._pause )
				return;

			if ( null != self._selected.index ) {
				if ( null == self._selected.shard ) {
					self._write_out_info_cells(
						self._indices[ self._selected.index ],
						null,
						$( '#indices-info-footer tbody.monitor tr.index' ),
						$( '#indices-info-footer tbody.monitor tr.shard' )
					);
					// Draw segments
					segments.draw_segments_for( self._selected.index, null );
				} else {
					self._write_out_info_cells(
						self._indices[ self._selected.index ],
						self._indices[ self._selected.index ][ 'shards' ][ self._selected.shard ],
						$( '#indices-info-footer tbody.monitor tr.index' ),
						$( '#indices-info-footer tbody.monitor tr.shard' )
					);
					// Draw segments
					segments.draw_segments_for( self._selected.index, self._selected.shard );
				}
			} else {
				// Clear segments
				segments.clear_segments();
			}

			if ( null != self._hover.index ) {
				if ( null == self._hover.shard ) {
					self._write_out_info_cells(
						self._indices[ self._hover.index ],
						null,
						$( '#indices-info-footer tbody.inspect tr.index' ),
						$( '#indices-info-footer tbody.inspect tr.shard' )
					);
				} else {
					self._write_out_info_cells(
						self._indices[ self._hover.index ],
						self._indices[ self._hover.index ][ 'shards' ][ self._hover.shard ],
						$( '#indices-info-footer tbody.inspect tr.index' ),
						$( '#indices-info-footer tbody.inspect tr.shard' )
					);
				}
			}

			// Set highlight state
			if ( 0 == _.keys( self._highlight_shards ).length ) {
				$( '#indices-svg-container' ).removeClass( 'highlight_shards' );
			} else {
				$( '#indices-svg-container' ).addClass( 'highlight_shards' );
			}

			var indices = self._get_filtered_indices(),
				svg_index_height = 100,
				index_x = d3
					.scale
					.linear()
					.range( [ 0, self._svg_width ] )
					.domain( [ 0, indices.indices.length ] ),
				index_h = d3
					.scale
					.linear()
					.range( [ svg_index_height, 0 ] )
					.domain( [ 0, d3.max( indices.indices, function(d) { return d.size.total; } ) ] ),
				index_axis = d3
					.svg
					.axis()
					.scale( index_h )
					.orient( "left" )
					.ticks( 1 )
					.tickFormat( function(d) { return d3.format( '.2s' )( d ) + 'B' } ),
				shard_h = d3
					.scale
					.linear()
					.range( [ 0, self._svg_height - svg_index_height ] )
					.domain( [ 0, d3.max( indices.indices, function(d) { return d.number_of_shards; } ) ] ),
				shard_bytes = d3
					.scale
					.pow()
					.exponent( 2 )
					.range( [ "#eeeeee", "#179fb0" ] )
					.domain( [
						0,
						d3.max(
							indices.indices,
							function(d) {
								return d3.max(
									_.values( d.shards ),
									function(d) { return d.size.primary; }
								);
							}
						)
					] ),
				shard_axis = d3
					.svg
					.axis()
					.scale( shard_h )
					.orient( "right" )
					.tickValues( [ d3.max( [
						0,
						d3.max( indices.indices, function(d) { return d.number_of_shards; } )
					] ) ] )
					.tickFormat( function(d) { return Math.round( d ) } ),
				ratio_y = d3
					.scale
					.linear()
					.range( [ svg_index_height, 0 ] )
					.domain( [ 0, 0.5 ] ),
				ratio_line = d3
					.svg
					.line()
					.x( function(d, i) { return index_x( i + 0.5 ); } )
					.y( function(d) { return ratio_y( d.docs.deleted_ratio ); } ),
				ratio_axis = d3
					.svg
					.axis()
					.scale( ratio_y )
					.orient( "right" )
					.tickValues( [ 0, .25, .5 ] )
					.tickFormat( function(d) { return Math.round( d * 100 ) + '%' } );

			$( '#indices h2 small' ).text( '(' + indices.counts.filtered + '/' + indices.counts.total + ' Indices)' );

			self._svg
				.selectAll( 'g' )
				.remove();

			var index_g = self._svg
				.selectAll( '.index' )
				.data( indices.indices, function(d) { return d.id; } )
				.enter()
				.append( 'g' )
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")")
				.attr( 'data-index', function(d) { return JSON.stringify( _.omit( d, 'shards' ) ); } )
				.attr( 'class', function(d) {
					var classes = 'index status-' + d.status;
					if ( self._selected.index == d.id && self._selected.shard == null )
						classes += ' selected';
					return classes;
				} )
				.attr( 'id', function(d) { return 'index-' + d.id; } )
				.on( "click", function( d ) {
					var e = d3.event,
						isSelected = d3.select( this ).classed( "selected" );

					// Unselect everything else
					d3.selectAll( '#indices g.selected' ).classed( "selected", false );
					// Toggle select
					d3.select( this ).classed( "selected", !isSelected );

					if ( !isSelected ) {
						$( '#indices-svg-container' ).addClass( 'selected' );
						$( '#indices' ).addClass( 'selected' );
						self._selected = {
							index: d.id,
							shard: null
						};
						// Draw segments
						segments.draw_segments_for( d.id, null );
					} else {
						$( '#indices-svg-container' ).removeClass( 'selected' );
						$( '#indices' ).removeClass( 'selected' );
						self._selected = {
							index: null,
							shard: null
						};
					}
				} );

			// Index primary size
			index_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return index_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return index_h( d.size.primary );
				}  )
				.attr( "width", index_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return svg_index_height - index_h( d.size.primary );
				} )
				.classed( { 'primary': true } );

			// Index total size
			index_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return index_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return index_h( d.size.total );
				}  )
				.attr( "width", index_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return svg_index_height - index_h( d.size.total );
				} )
				.classed( { 'total': true } );

			// Hover & click target
			index_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return index_x( i );
				} )
				.attr( "y", 0 )
				.attr( "width", index_x( 1 ) )
				.attr( "height", svg_index_height )
				.attr( 'data-powertip', function(d) {
					var tooltip = '<strong>' + d.id + '</strong>';
					tooltip += d3.format( '.3s' )( d.size.total ) + 'B Total';
					tooltip += '<br>' + d3.format( '.3s' )( d.size.primary ) + 'B Primary';
					tooltip += '<br>' + d3.format( '.2f' )( d.docs.deleted_ratio * 100 ) + '% Deleted';
					return tooltip;
				} )
				.classed( { 'hover-target': true } );

			self._svg
				.append("g")
				.attr("class", "y axis")
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")")
				.call(index_axis)
				.selectAll("text")
				.attr("dy", "1em")
				.attr("transform", "rotate(45)");

			_.each( indices.indices, function( index, count ) {
				var shard_g = self._svg
					.selectAll( '.shard-' + index.id )
					.data( _.values( index.shards ), function( d ) { return index.id + '-' + d.shard_num; } )
					.enter()
					.append( 'g' )
					.attr("transform", "translate("+(self._svg_padding_x+index_x(count))+","+(self._svg_padding_y+svg_index_height)+")")
					.attr( 'data-shard', function(d) { return JSON.stringify( d ); } )
					.attr( 'data-index', function(d) { return JSON.stringify( _.omit( index, 'shards' ) ); } )
					.attr( 'class', function(d) {
						var classes = 'shard shard-' + index.id;
						if ( self._selected.index == index.id && self._selected.shard == d.shard_num )
							classes += ' selected';

						// Highlight selection
						if ( undefined != self._highlight_shards[ index.id ] && undefined != self._highlight_shards[ index.id ][ d.shard_num ] ) {
							if ( 'P' == self._highlight_shards[ index.id ][ d.shard_num ] ) {
								classes += ' highlight highlight-primary';
							} else {
								classes += ' highlight highlight-replica';
							}
						}

						return classes;
					} )
					.attr( 'id', function(d) { return 'shard-' + index.id + '-' + d.shard_num; } );

				shard_g
					.append( 'rect' )
					.attr( "x", function( d, i ) {
						return index_x( 1/10 );
					} )
					.attr( "y", function( d, i ) {
						return shard_h( d.shard_num );
					}  )
					.attr( "width", index_x( 1 - 2/10 ) )
					.attr( "height", function( d ) {
						return shard_h( 1 );
					} )
					.style( "fill", function( d ) {
						// Heatmap!
						if ( 'green' == d.status && 0 == d.relocating_shards ) {
							return shard_bytes( d.size.primary );
						}

						// Highlight problems
						var shard_states = {
							'UNASSIGNED': false,
							'INITIALIZING': false,
							'RELOCATING': false,
							'STARTED': false
						};

						_.each( d.shards, function( shard ) {
							shard_states[ shard.state ] = true;
						} );

						if ( shard_states[ 'UNASSIGNED' ] )
							return '#d0363e'; // Red
						else if ( shard_states[ 'INITIALIZING' ] )
							return '#ef6642'; // Orange
						else if ( shard_states[ 'RELOCATING' ] )
							return '#f0c556'; // Yellow
						else
							return '#d0363e'; // Red
					} )
					.attr( 'data-powertip', function(d) {
						var tooltip = '<strong>' + index.id + ' &mdash; ' + d.shard_num + '</strong>';
						tooltip += d3.format( '.3s' )( d.size.primary ) + 'B Primary';

						if ( !( 'green' == d.status && 0 == d.relocating_shards ) ) {
							_.each( d.shards, function( shard_instance ) {
								if ( 'STARTED' == shard_instance.state ) {
									return;
								}

								if ( 'INITIALIZING' == shard_instance.state ) {
									tooltip += '<em>Initializing Onto</em>→&nbsp;' + nodes.get_node( shard_instance.node ).name;
									return;
								}

								if ( 'RELOCATING' == shard_instance.state ) {
									tooltip += '<em>Relocating From &amp; To</em>←&nbsp;' + nodes.get_node( shard_instance.node ).name + '<br>→&nbsp;' + nodes.get_node( shard_instance.relocating_node ).name;
									return;
								}
							} );
						}

						return tooltip;
					} )
					.on( "click", function( d ) {
						var e = d3.event,
							g = this.parentNode,
							isSelected = d3.select( g ).classed( "selected" );

						// Unselect everything else
						d3.selectAll( '#indices g.selected' ).classed( "selected", false );
						// Toggle select
						d3.select( g ).classed( "selected", !isSelected );

						if ( !isSelected ) {
							$( '#indices-svg-container' ).addClass( 'selected' );
							$( '#indices' ).addClass( 'selected' );
							self._selected = {
								index: index.id,
								shard: d.shard_num
							};
							// Draw segments
							segments.draw_segments_for( index.id, d.shard_num );
						} else {
							$( '#indices-svg-container' ).removeClass( 'selected' );
							$( '#indices' ).removeClass( 'selected' );
							self._selected = {
								index: null,
								shard: null
							};
						}
					} );
			} );

			// Add a legend for number of shards
			self._svg
				.append("g")
				.attr("class", "y axis")
				.attr("transform", "translate("+(self._svg_width+self._svg_padding_x)+","+(self._svg_padding_y+svg_index_height)+")")
				.call(shard_axis)
				.selectAll("text");

			// Add a legend for the color values
			var shard_legend = self._svg
				.selectAll( ".shard-legend" )
				.data( shard_bytes.ticks(6).slice(1).reverse() )
				.enter()
				.append( "g" )
				.attr( "class", "shard-legend" )
				.attr( "transform", function( d, i ) {
					return "translate(0," + ( self._svg_padding_y + svg_index_height + i * 16 + 16 ) + ")";
				} );

			shard_legend
				.append( "rect" )
				.attr( "width", 16 )
				.attr( "height", 16 )
				.style( "fill", shard_bytes );

			shard_legend
				.append( "text" )
				.attr( "x", 16 )
				.attr( "dy", "-.25em" )
				.attr( "dx", "0.5em" )
				.attr("transform", "rotate(45)")
				.text( function( d ) { return d3.format( '.2s' )( d ) + 'B' } );

			// Delete ratio
			var ratio_g = self._svg
				.append( 'g' )
				.attr( 'class', 'index_ratio' )
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")");

			ratio_g
				.append("path")
				.datum(indices.indices)
				.attr("class", "line")
				.attr("d", ratio_line);

			ratio_g
				.selectAll('circle')
				.data(indices.indices)
				.enter()
				.append('circle')
				.attr("cx", function(d, i) { return index_x( i + 0.5 ); } )
				.attr("cy", function(d) { return ratio_y( d.docs.deleted_ratio ); } )
				.attr("r", 1.5)
				.attr("class", "line-point");

			self._svg
				.append("g")
				.attr("class", "y axis")
				.attr("transform", "translate("+(self._svg_width+self._svg_padding_x)+","+self._svg_padding_y+")")
				.call(ratio_axis);
		},

		set_highlight_shards: function( highlight_shards ) {
			var self = this;
			self._highlight_shards = highlight_shards;
			self.render();
		},

		_get_filtered_indices: function() {
			var self = this;
			var counts = {
				'total': _.keys( self._indices ).length,
				'filtered': 0,
			};

			var filtered = _.values( self._indices );

			// Apply filter from UI
			var filter = $( '#indices-filter' ).val();
			if ( '' != filter ) {
				var regex = new RegExp( filter, 'i' );
				filtered = _.filter( filtered, function( index ) {
					return null != index.id.match( regex );
				} );
			}
			counts.filtered = filtered.length;

			// Sort indices
			filtered.sort( function( a, b ) {
				return alphanum( a.sortkey, b.sortkey );
			} );

			return {
				'counts': counts,
				'indices': filtered
			};
		},

		_notify_nodes_of_shards: function() {
			var self = this;

			if ( self._is_refreshing )
				return;

			var node_shards = {};
			_.each( self._indices, function( index ) {
				_.each( index.shards, function( shard ) {
					_.each( shard.shards, function( shard_instance ) {
						var template = {};
						template[ shard_instance.node ] = {
							'UNASSIGNED': [],
							'INITIALIZING': [],
							'RELOCATING': [],
							'STARTED': []
						};
						node_shards =_.defaults( node_shards, template );

						node_shards[ shard_instance.node ][ shard_instance.state ].push( shard_instance );
					} );
				} );
			} );

			nodes.set_shards( node_shards );
		}
	};

	var segments = {
		_svg_padding_x: 40,
		_svg_padding_y: 20,
		_svg_width: 390,
		_svg_height: 150,
		_segment_size: {
			min: 0,
			max: 0
		},
		_rendered: {
			index: null,
			shard_num: null
		},
		_resize: {
			aspect_ratio: null,
			width: null,
			height: null
		},
		_pause: false,

		init: function() {
			var self = this;

			self._resize.aspect_ratio = ( self._svg_width + self._svg_padding_x * 2 ) / ( self._svg_height + self._svg_padding_y * 2 );
			self._resize.width = self._svg_width + self._svg_padding_x * 2,
			self._resize.height = self._resize.width / self._resize.aspect_ratio;

			self.resize();
			$(window).on("resize", function() {
				self.resize();
			} );

			$( document ).on( 'mouseover', '#segments-rendered .segment', function( event ) {
				var element = $( this )

				self._pause = true;

				if ( !element.data( 'powertip-init' ) ) {
					element.powerTip( {
						manual: true,
						placement: 's',
						smartPlacement: true
					} );
					element.data( 'powertip-init', true );
				}

				$.powerTip.show( this, event );
			} );
			$( document ).on( 'mouseleave', '#segments-rendered .segment', function( event ) {
				$.powerTip.hide( this );
				self._pause = false;
			} );
		},

		resize: function() {
			var self = this,
				charts = $(".segments-svg"),
				target = $('#segments-rendered');

			self._resize.width = target.width() / 2,
			self._resize.height = self._resize.width / self._resize.aspect_ratio;

			charts.attr("width", self._resize.width);
			charts.attr("height", self._resize.height);
		},

		clear_segments: function() {
			$( '#segments-rendered' ).html( '' );
			self._rendered = {
				index: null,
				shard_num: null
			};
		},

		draw_segments_for: function( index, shard_num ) {
			var self = this;

			if ( self._pause )
				return;

			$.when(
				$.getJSON( cluster.get_info().host + '/' + index + '/_segments' )
			)
			.done(function( results ) {

				if ( null == shard_num ) {
					var shards = results.indices[ index ][ 'shards' ];
				} else {
					var shards = _.pick( results.indices[ index ][ 'shards' ], shard_num );
				}

				var primary_shard_segments = {};
				_.each( shards, function( shard, shard_num ) {
					_.each( shard, function( shard_instance, index ) {
						var sortkey;
						if ( shard_instance.routing.primary ) {
							sortkey = 'P ';
						} else {
							sortkey = 'R '
						}

						var node = nodes.get_node( shard_instance.routing.node );
						if ( node )
							sortkey += node.sortkey;

						shards[ shard_num ][ index ][ 'sortkey' ] = sortkey;
						shards[ shard_num ][ index ][ 'nodename' ] = node.name;

						if ( shard_instance.routing.primary ) {
							primary_shard_segments[ shard_num ] = _.keys( shard_instance.segments );
						}
					} );

					shards[ shard_num ].sort( function( a, b ) {
						return alphanum( a.sortkey, b.sortkey );
					} );
				} );

				_.each( shards, function( shard, shard_num ) {
					_.each( shard, function( shard_instance, index ) {
						_.each( shard_instance.segments, function( segment, segment_id ) {
							shards[ shard_num ][ index ][ 'segments' ][ segment_id ][ 'id' ] = segment_id;
							shards[ shard_num ][ index ][ 'segments' ][ segment_id ][ 'on_primary' ] = ( _.indexOf( primary_shard_segments[ shard_num ], segment_id ) >= 0 );
							shards[ shard_num ][ index ][ 'segments' ][ segment_id ][ 'deleted_ratio' ] = get_deleted_ratio( segment.num_docs, segment.deleted_docs );
						} );
					} );
				} );

				self._render( index, shard_num, shards );
			} );
		},

		_render: function( index, shard_num, shards ) {
			var self = this,
				redraw = false;

			if ( self._pause )
				return;

			if ( self._rendered.index != index || self._rendered.shard_num != shard_num ) {
				var html = '';
				_.each( shards, function( shard, shard_num ) {
					html += '<h3>Index:' + index + ' &mdash; Shard:' + shard_num + '</h3>';
					_.each( shard, function( shard_instance, index ) {
						html += '<svg class="segments-svg" id="segments-rendered-' + index + '-' + shard_num + '-' + shard_instance.routing.node + '" />';
					} );
				} );
				$( '#segments-rendered' ).html( html );
				self._rendered = {
					index: index,
					shard_num: shard_num
				};
				redraw = true;
			}

			self._segment_size = {
				min: null,
				max: null
			};
			self._max_num_segments = 0;
			_.each( shards, function( shard, shard_num ) {
				self._max_num_segments = Math.max(
					self._max_num_segments,
					d3.max( shard, function(d) { return _.keys( d.segments ).length; } )
				);
				_.each( shard, function( shard_instance, index ) {
					if ( 0 == _.keys( shard_instance.segments ).length )
						return;

					if ( null == self._segment_size.min ) {
						self._segment_size = {
							min: d3.min( _.values( shard_instance.segments ), function(d) { return d.size_in_bytes; } ),
							max: d3.max( _.values( shard_instance.segments ), function(d) { return d.size_in_bytes; } )
						};
					} else {
						self._segment_size.min = Math.min(
							self._segment_size.max,
							d3.min( _.values( shard_instance.segments ), function(d) { return d.size_in_bytes; } )
						);
						self._segment_size.max = Math.max(
							self._segment_size.max,
							d3.max( _.values( shard_instance.segments ), function(d) { return d.size_in_bytes; } )
						);
					}
				} );
			} );

			if ( self._segment_size.min == self._segment_size.max )
				self._segment_size.min = 0;

			_.each( shards, function( shard, shard_num ) {
				_.each( shard, function( shard_instance, index ) {
					self._render_shard( index, shard_num, shard_instance );
				} );
			} );

			if ( redraw )
				self.resize();
		},

		_render_shard: function( index, shard_num, shard_instance ) {
			var self = this,
				segments = _.values( shard_instance.segments ),
				segment_x = d3
					.scale
					.linear()
					.range( [ 0, self._svg_width ] )
					.domain( [ 0, self._max_num_segments ] ),
				segment_y = d3
					.scale
					.log()
					.clamp( true )
					.nice()
					.range( [ self._svg_height, 0 ] )
					.domain( [ self._segment_size.max/10000, self._segment_size.max ] ),
				segment_axis = d3
					.svg
					.axis()
					.scale( segment_y )
					.orient( "left" )
					.ticks( 1, function(d) { return d3.format( '.1s' )( d ) + 'B' } ),
				ratio_y = d3
					.scale
					.linear()
					.range( [ self._svg_height, 0 ] )
					.domain( [ 0, 0.5 ] ),
				ratio_line = d3
					.svg
					.line()
					.x( function(d, i) { return segment_x( i + 0.5 ); } )
					.y( function(d) { return ratio_y( d.deleted_ratio ); } ),
				ratio_axis = d3
					.svg
					.axis()
					.scale( ratio_y )
					.orient( "right" )
					.ticks( 5 )
					.tickFormat( function(d) { return Math.round( d * 100 ) + '%' } )
				svg = d3
					.select( '#segments-rendered-' + index + '-' + shard_num + '-' + shard_instance.routing.node );

			// Sort segments
			segments.sort( function( a, b ) {
				if ( b.size_in_bytes != a.size_in_bytes ) {
					// Large -> Small size; small shards merge into larger ones
					return b.size_in_bytes - a.size_in_bytes;
				} else if ( b.deleted_ratio != a.deleted_ratio ) {
					// Less -> More deleted; more deleted more likely to merge
					return a.deleted_ratio - b.deleted_ratio;
				} else {
					// Older -> Newer gen; newer gen from new merges / created
					return a.generation - b.generation
				}
			} );

			if ( undefined == svg.attr( 'preserveAspectRatio' ) ) {
				svg
					.attr( 'width', self._svg_width + self._svg_padding_x * 2 )
					.attr( 'height', self._svg_height + self._svg_padding_y * 2 )
					.attr( 'viewBox', "0 0 " + ( self._svg_width + self._svg_padding_x * 2 ) + " " + ( self._svg_height + self._svg_padding_y * 2 ) )
					.attr( 'preserveAspectRatio', "xMidYMid" );
			}

			svg
				.selectAll( 'g' )
				.remove();
			svg
				.selectAll( 'text' )
				.remove();

			var segment_g = svg
				.selectAll( '.segment' )
				.data( segments, function(d) {
					return index + '-' + shard_num + '-' + shard_instance.routing.node + '-' + d.id;
				} )
				.enter()
				.append( 'g' )
				.attr( "transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")" )
				.attr( 'data-segment', function(d) { return JSON.stringify( d ); } )
				.attr( 'data-powertip', function(d) {
					var tooltip = '<strong>' + d.id + '</strong>';

					if ( d.committed && d.search && d.on_primary ) {
						tooltip += 'Synced (Primary)';
					} else if ( d.committed && d.search ) {
						tooltip += 'Synced';
					} else if ( d.committed ) {
						tooltip += 'Committed';
					} else {
						tooltip += 'Uncommitted';
					}

					tooltip += '<br>' + d3.format( '.3s' )( d.size_in_bytes ) + 'B';
					tooltip += '<br>' + d3.format( '.3s' )( d.num_docs ) + ' Docs';
					tooltip += '<br>' + d3.format( '.2f' )( d.deleted_ratio * 100 ) + '% Deleted';
					return tooltip;
				} )
				.attr( 'class', function(d) {
					var class_names = 'segment';

					if ( d.committed && d.search && d.on_primary ) {
						class_names += ' synced-primary';
					} else if ( d.committed && d.search ) {
						class_names += ' synced-local';
					} else if ( d.committed ) {
						class_names += ' committed';
					} else {
						class_names += ' uncommitted';
					}
					return class_names
				} )
				.attr( 'id', function(d) { return 'segment-' + index + '-' + shard_num + '-' + shard_instance.routing.node + '-' + d.id; } );

			segment_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return segment_x( i );
				} )
				.attr( "y", 0 )
				.attr( "width", segment_x( 1 ) )
				.attr( "height", self._svg_height )
				.classed( { 'hover-target': true } );

			segment_g
				.append( 'rect' )
				.attr( "x", function( d, i ) {
					return segment_x( i + 1/10 );
				} )
				.attr( "y", function( d ) {
					return segment_y( d.size_in_bytes );
				}  )
				.attr( "width", segment_x( 1 - 2/10 ) )
				.attr( "height", function( d ) {
					return self._svg_height - segment_y( d.size_in_bytes ) + 1;
				} )
				.classed( { 'size': true } );

			svg
				.append("g")
				.attr("class", "y axis")
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")")
				.call(segment_axis)
				.selectAll("text")
				.attr("dy", "1em")
				.attr("transform", "rotate(45)");

			// Delete ratio
			var ratio_g = svg
				.append( 'g' )
				.attr( 'class', 'node_ratio' )
				.attr("transform", "translate("+self._svg_padding_x+","+self._svg_padding_y+")");

			ratio_g
				.append("path")
				.datum(segments)
				.attr("class", "line")
				.attr("d", ratio_line);

			ratio_g
				.selectAll('circle')
				.data(segments)
				.enter()
				.append('circle')
				.attr("cx", function(d, i) { return segment_x( i + 0.5 ); } )
				.attr("cy", function(d) { return ratio_y( d.deleted_ratio ); } )
				.attr("r", 1.5)
				.attr("class", "line-point");

			svg
				.append("g")
				.attr("class", "y axis ratio")
				.attr("transform", "translate("+(self._svg_width+self._svg_padding_x)+","+self._svg_padding_y+")")
				.call(ratio_axis);

			var label = shard_instance.nodename;
			if ( shard_instance.routing.primary )
				label += ' (Primary)';
			else
				label += ' (Replica)';
			svg
				.append( "text" )
				.attr( "x", (self._svg_width / 2) + self._svg_padding_x )
				.attr( "y", self._svg_height + self._svg_padding_y * 1.75 )
				.attr( "text-anchor", "middle" )
				.text( label );

		}
	};

	// Utils

	// Natual sort -- http://my.opera.com/GreyWyvern/blog/show.dml/1671288
	var alphanum = function(a, b) {
		function chunkify(t) {
			var tz = [], x = 0, y = -1, n = 0, i, j;

			while (i = (j = t.charAt(x++)).charCodeAt(0)) {
				var m = (i == 46 || (i >=48 && i <= 57));
				if (m !== n) {
					tz[++y] = "";
					n = m;
				}
				tz[y] += j;
			}
			return tz;
		}

		var aa = chunkify(a);
		var bb = chunkify(b);

		for (x = 0; aa[x] && bb[x]; x++) {
			if (aa[x] !== bb[x]) {
				var c = Number(aa[x]), d = Number(bb[x]);
				if (c == aa[x] && d == bb[x])
					return c - d;
				else
					return (aa[x] > bb[x]) ? 1 : -1;
			}
		}
		return aa.length - bb.length;
	}

	var get_deleted_ratio = function( docs, deleted ) {
		if ( 0 == deleted )
			return 0;
		else
			return deleted / ( docs + deleted );
	}

	$( function() {
		cluster.init();
		$.fn.powerTip.smartPlacementLists.e = ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's', 'e'];
	} );
})(jQuery);